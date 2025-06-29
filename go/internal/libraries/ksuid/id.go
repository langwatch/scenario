package ksuid

import (
	"bytes"
	"database/sql/driver"
	"encoding/binary"
	"encoding/json"

	"github.com/jamescun/basex"
)

// ID is an optionally prefixed, k-sortable globally unique ID.
type ID struct {
	Environment string
	Resource    string

	Timestamp  uint64
	InstanceID InstanceID
	SequenceID uint32
}

const (
	decodedLen = 21
	encodedLen = 29
)

// MustParse unmarshals an ID from a string and panics on error.
func MustParse(src string) ID {
	id, err := Parse(src)
	if err != nil {
		panic(err)
	}

	return id
}

// Parse unmarshals an ID from a series of bytes.
func Parse(str string) (id ID, err error) {
	var src []byte
	id.Environment, id.Resource, src = splitPrefixID([]byte(str))

	if id.Environment == "" {
		id.Environment = Production
	}

	if len(src) < encodedLen {
		err = &ParseError{"ksuid too short"}
		return
	} else if len(src) > encodedLen {
		err = &ParseError{"ksuid too long"}
		return
	}

	dst := make([]byte, decodedLen)
	err = fastDecodeBase62(dst, src)
	if err != nil {
		err = &ParseError{"invalid base62: " + err.Error()}
		return
	}

	id.Timestamp = binary.BigEndian.Uint64(dst[:8])
	id.InstanceID.SchemeData = dst[8]
	copy(id.InstanceID.BytesData[:], dst[9:17])
	id.SequenceID = binary.BigEndian.Uint32(dst[17:])

	return
}

func splitPrefixID(input []byte) (environment, resource string, id []byte) {
	// NOTE(jc): this function is optimized to reduce conditional branching
	// on the hot path/most common use case.

	lastIdx := bytes.LastIndexByte(input, '_')
	if lastIdx < 0 {
		id = input
		return
	}

	firstIdx := bytes.IndexByte(input[:lastIdx], '_')
	if firstIdx > -1 {
		environment = string(input[:firstIdx])
		resource = string(input[firstIdx+1 : lastIdx])
		id = input[lastIdx+1:]
		return
	}

	resource = string(input[:lastIdx])
	id = input[lastIdx+1:]

	return
}

// IsZero returns true if id has not yet been initialized.
func (id ID) IsZero() bool {
	return id == ID{}
}

// Equal returns true if the given ID matches id of the caller.
func (id ID) Equal(x ID) bool {
	return id == x
}

// Scan implements a custom database/sql.Scanner to support
// unmarshaling from standard database drivers.
func (id *ID) Scan(src any) error {
	switch src := src.(type) {
	case string:
		n, err := Parse(src)
		if err != nil {
			return err
		}

		*id = n
		return nil

	case []byte:
		n, err := Parse(string(src))
		if err != nil {
			return err
		}

		*id = n
		return nil

	default:
		return &ParseError{"unsupported scan, must be string or []byte"}
	}
}

// Value implements a custom database/sql/driver.Valuer to support
// marshaling to standard database drivers.
func (id ID) Value() (driver.Value, error) {
	return id.Bytes(), nil
}

func (id ID) prefixLen() (n int) {
	if id.Resource != "" {
		n += len(id.Resource) + 1

		if id.Environment != "" && id.Environment != Production {
			n += len(id.Environment) + 1
		}
	}

	return
}

// MarshalJSON implements a custom JSON string marshaler.
func (id ID) MarshalJSON() ([]byte, error) {
	b := id.Bytes()
	x := make([]byte, len(b)+2)
	x[0] = '"'
	copy(x[1:], b)
	x[len(x)-1] = '"'
	return x, nil
}

// UnmarshalJSON implements a custom JSON string unmarshaler.
func (id *ID) UnmarshalJSON(b []byte) (err error) {
	var str string
	err = json.Unmarshal(b, &str)
	if err != nil {
		return
	}

	n, err := Parse(str)
	if err != nil {
		return
	}

	*id = n
	return
}

// Bytes stringifies and returns ID as a byte slice.
func (id ID) Bytes() []byte {
	prefixLen := id.prefixLen()
	dst := make([]byte, prefixLen+encodedLen)

	if id.Resource != "" {
		offset := 0
		if id.Environment != "" && id.Environment != Production {
			copy(dst, id.Environment)
			dst[len(id.Environment)] = '_'
			offset = len(id.Environment) + 1
		}

		copy(dst[offset:], id.Resource)
		dst[offset+len(id.Resource)] = '_'
	}

	iid := id.InstanceID.Bytes()

	decodedBytes := make([]byte, decodedLen)
	encodedBytes := make([]byte, encodedLen)
	binary.BigEndian.PutUint64(decodedBytes, id.Timestamp)
	decodedBytes[8] = id.InstanceID.Scheme()
	copy(decodedBytes[9:], iid[:])
	binary.BigEndian.PutUint32(decodedBytes[17:], id.SequenceID)

	basex.Base62.Encode(encodedBytes, decodedBytes)
	copy(dst[prefixLen+2:], encodedBytes)

	dst[prefixLen] = '0'
	dst[prefixLen+1] = '0'

	return dst
}

// String stringifies and returns ID as a string.
func (id ID) String() string {
	return string(id.Bytes())
}

// ParseError is returned when unexpected input is encountered when
// parsing user input to an ID.
type ParseError struct {
	errorString string
}

func (pe ParseError) Error() string {
	return pe.errorString
}
