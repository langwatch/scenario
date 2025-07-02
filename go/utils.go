package scenario

import (
	"strings"
	"unicode"
)

func criterionNameToParamName(criterion string) string {
	// Remove all double quotes
	criterion = strings.ReplaceAll(criterion, "\"", "")

	// Replace all non-alphanumeric characters with underscores, and convert to lowercase as we go
	var result strings.Builder
	for _, r := range criterion {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			result.WriteRune(unicode.ToLower(r))
		} else {
			result.WriteRune('_')
		}
	}
	param := result.String()

	// Truncate to 70 characters
	if len(param) > 70 {
		param = param[:70]
	}

	return param
}
