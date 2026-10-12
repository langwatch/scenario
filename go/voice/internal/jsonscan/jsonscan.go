// Package jsonscan walks JSON objects and arrays in place, without decoding
// them, so a realtime adapter can pick the audio payload out of a media
// frame with no allocation. It validates only as far as it walks: values it
// skips are delimited, not checked.
package jsonscan

import "bytes"

// Fields calls fn with the raw key (between its quotes, escapes left as is)
// and the raw value of each member of the object obj, stopping when fn
// returns false. It reports false when obj is not an object it could walk.
func Fields(obj []byte, fn func(key, value []byte) bool) bool {
	i := skipSpace(obj, 0)
	if i >= len(obj) || obj[i] != '{' {
		return false
	}
	i = skipSpace(obj, i+1)
	if i < len(obj) && obj[i] == '}' {
		return true
	}
	for i < len(obj) {
		if obj[i] != '"' {
			return false
		}
		end, ok := skipString(obj, i)
		if !ok {
			return false
		}
		key := obj[i+1 : end-1]
		i = skipSpace(obj, end)
		if i >= len(obj) || obj[i] != ':' {
			return false
		}
		i = skipSpace(obj, i+1)
		vend, ok := skipValue(obj, i)
		if !ok {
			return false
		}
		if !fn(key, obj[i:vend]) {
			return true
		}
		i = skipSpace(obj, vend)
		if i >= len(obj) {
			return false
		}
		switch obj[i] {
		case ',':
			i = skipSpace(obj, i+1)
		case '}':
			return true
		default:
			return false
		}
	}
	return false
}

// Elements calls fn with the raw value of each element of the array arr,
// stopping when fn returns false. It reports false when arr is not an array
// it could walk.
func Elements(arr []byte, fn func(value []byte) bool) bool {
	i := skipSpace(arr, 0)
	if i >= len(arr) || arr[i] != '[' {
		return false
	}
	i = skipSpace(arr, i+1)
	if i < len(arr) && arr[i] == ']' {
		return true
	}
	for i < len(arr) {
		end, ok := skipValue(arr, i)
		if !ok {
			return false
		}
		if !fn(arr[i:end]) {
			return true
		}
		i = skipSpace(arr, end)
		if i >= len(arr) {
			return false
		}
		switch arr[i] {
		case ',':
			i = skipSpace(arr, i+1)
		case ']':
			return true
		default:
			return false
		}
	}
	return false
}

// Field returns the raw value of the member key of the object obj.
func Field(obj []byte, key string) ([]byte, bool) {
	var out []byte
	found := false
	Fields(obj, func(k, v []byte) bool {
		if string(k) == key {
			out, found = v, true
			return false
		}
		return true
	})
	return out, found
}

// String returns the contents of the JSON string v without its quotes.
// escaped reports a backslash escape inside, which the caller must decode
// (with encoding/json) before using the text. ok is false when v is not a
// string.
func String(v []byte) (s []byte, escaped, ok bool) {
	if len(v) < 2 || v[0] != '"' || v[len(v)-1] != '"' {
		return nil, false, false
	}
	s = v[1 : len(v)-1]
	return s, bytes.IndexByte(s, '\\') >= 0, true
}

// IsTrue reports whether v is the literal true.
func IsTrue(v []byte) bool { return string(v) == "true" }

// IsNull reports whether v is absent or the literal null.
func IsNull(v []byte) bool { return len(v) == 0 || string(v) == "null" }

func skipSpace(b []byte, i int) int {
	for i < len(b) {
		switch b[i] {
		case ' ', '\t', '\n', '\r':
			i++
		default:
			return i
		}
	}
	return i
}

// skipString returns the index just past the string starting at b[i].
func skipString(b []byte, i int) (int, bool) {
	j := i + 1
	for {
		k := bytes.IndexByte(b[j:], '"')
		if k < 0 {
			return 0, false
		}
		q := j + k
		// An odd run of backslashes before the quote escapes it.
		n := 0
		for p := q - 1; p > i && b[p] == '\\'; p-- {
			n++
		}
		if n%2 == 0 {
			return q + 1, true
		}
		j = q + 1
	}
}

// skipValue returns the index just past the value starting at b[i].
func skipValue(b []byte, i int) (int, bool) {
	if i >= len(b) {
		return 0, false
	}
	switch b[i] {
	case '"':
		return skipString(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				end, ok := skipString(b, j)
				if !ok {
					return 0, false
				}
				j = end - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1, true
				}
			}
		}
		return 0, false
	default:
		j := i
		for j < len(b) {
			switch b[j] {
			case ',', '}', ']', ' ', '\t', '\n', '\r':
				if j == i {
					return 0, false
				}
				return j, true
			}
			j++
		}
		if j == i {
			return 0, false
		}
		return j, true
	}
}
