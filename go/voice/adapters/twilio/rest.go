package twilio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/langwatch/scenario/go/voice/internal/apihttp"
)

// DefaultRESTBaseURL is Twilio's REST API root.
const DefaultRESTBaseURL = "https://api.twilio.com/2010-04-01"

// REST is the Twilio REST surface the adapter uses. [RESTClient]
// implements it; tests and host platforms may supply their own.
type REST interface {
	// ResolvePhoneNumberSID looks up the PN… SID of a number the account owns.
	ResolvePhoneNumberSID(ctx context.Context, phoneNumber string) (string, error)
	// ReadVoiceURL returns the voice_url configured on the number ("" when unset).
	ReadVoiceURL(ctx context.Context, phoneNumberSID string) (string, error)
	// WriteVoiceURL sets the number's voice_url.
	WriteVoiceURL(ctx context.Context, phoneNumberSID, voiceURL string) error
	// PlaceCall originates a call running inline TwiML and returns its SID.
	PlaceCall(ctx context.Context, p PlaceCallParams) (string, error)
	// EndCall hangs an in-progress call up (Status=completed).
	EndCall(ctx context.Context, callSID string) error
	// SendDTMF plays DTMF tones on an in-progress call by replacing its TwiML.
	SendDTMF(ctx context.Context, callSID, tones string) error
}

// PlaceCallParams are the Calls.create parameters.
type PlaceCallParams struct {
	To, From string
	// TwiML runs when the call connects. A TwiML URL is deliberately not
	// accepted (SSRF via Twilio if a caller ever passed an attacker URL).
	TwiML string
	// TimeLimitSeconds is Twilio's own maximum call duration (TimeLimit):
	// the only duration guard that still fires if this process dies. 0
	// omits it.
	TimeLimitSeconds int
	// Record asks Twilio to record the call (Record=true); false omits it.
	Record bool
}

// RESTClient is a minimal Twilio REST client over net/http: only the calls
// the adapter needs, no vendor SDK.
type RESTClient struct {
	AccountSID string
	AuthToken  string
	// HTTPClient sends the requests; nil uses http.DefaultClient.
	HTTPClient *http.Client
	// BaseURL overrides DefaultRESTBaseURL (tests, regional edges).
	BaseURL string
}

func (c *RESTClient) accountURL() string {
	base := c.BaseURL
	if base == "" {
		base = DefaultRESTBaseURL
	}
	return strings.TrimSuffix(base, "/") + "/Accounts/" + c.AccountSID
}

// request sends one call and decodes its JSON body into out (when non-nil).
// A non-2xx answer is an error naming the method, path and status and
// quoting the body.
func (c *RESTClient) request(ctx context.Context, method, path string, form url.Values, out any) error {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, c.accountURL()+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.AccountSID+":"+c.AuthToken)))
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	data, err := apihttp.Do(c.HTTPClient, req, "Twilio REST "+method+" "+path)
	if err != nil {
		return err
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		//lint:ignore ST1005 "Twilio REST <method> <path>" prefix, as in the JS SDK
		return fmt.Errorf("Twilio REST %s %s: decoding response: %w", method, path, err)
	}
	return nil
}

// ResolvePhoneNumberSID implements REST.
func (c *RESTClient) ResolvePhoneNumberSID(ctx context.Context, phoneNumber string) (string, error) {
	q := url.Values{"PhoneNumber": {phoneNumber}, "PageSize": {"1"}}
	var data struct {
		Numbers []struct {
			SID string `json:"sid"`
		} `json:"incoming_phone_numbers"`
	}
	if err := c.request(ctx, http.MethodGet, "/IncomingPhoneNumbers.json?"+q.Encode(), nil, &data); err != nil {
		return "", err
	}
	if len(data.Numbers) == 0 || data.Numbers[0].SID == "" {
		//lint:ignore ST1005 same message as the JS SDK's Twilio adapter
		return "", fmt.Errorf("No incoming phone number found on this Twilio account matching %s. "+
			"Check that the number is purchased and in E.164.", strconv.Quote(phoneNumber))
	}
	return data.Numbers[0].SID, nil
}

// ReadVoiceURL implements REST.
func (c *RESTClient) ReadVoiceURL(ctx context.Context, phoneNumberSID string) (string, error) {
	var data struct {
		VoiceURL string `json:"voice_url"`
	}
	err := c.request(ctx, http.MethodGet, "/IncomingPhoneNumbers/"+phoneNumberSID+".json", nil, &data)
	return data.VoiceURL, err
}

// WriteVoiceURL implements REST.
func (c *RESTClient) WriteVoiceURL(ctx context.Context, phoneNumberSID, voiceURL string) error {
	return c.request(ctx, http.MethodPost, "/IncomingPhoneNumbers/"+phoneNumberSID+".json",
		url.Values{"VoiceUrl": {voiceURL}}, nil)
}

// PlaceCall implements REST.
func (c *RESTClient) PlaceCall(ctx context.Context, p PlaceCallParams) (string, error) {
	form := url.Values{"To": {p.To}, "From": {p.From}, "Twiml": {p.TwiML}}
	if p.TimeLimitSeconds > 0 {
		form.Set("TimeLimit", strconv.Itoa(p.TimeLimitSeconds))
	}
	if p.Record {
		form.Set("Record", "true")
	}
	var data struct {
		SID string `json:"sid"`
	}
	if err := c.request(ctx, http.MethodPost, "/Calls.json", form, &data); err != nil {
		return "", err
	}
	if data.SID == "" {
		//lint:ignore ST1005 same message as the JS SDK's Twilio adapter
		return "", errors.New("Twilio REST Calls.create returned no sid")
	}
	return data.SID, nil
}

// EndCall implements REST.
func (c *RESTClient) EndCall(ctx context.Context, callSID string) error {
	return c.request(ctx, http.MethodPost, "/Calls/"+callSID+".json", url.Values{"Status": {"completed"}}, nil)
}

// SendDTMF implements REST.
func (c *RESTClient) SendDTMF(ctx context.Context, callSID, tones string) error {
	if err := ValidateDTMF(tones); err != nil {
		return err
	}
	twiml := `<Response><Play digits="` + tones + `"/></Response>`
	return c.request(ctx, http.MethodPost, "/Calls/"+callSID+".json", url.Values{"Twiml": {twiml}}, nil)
}
