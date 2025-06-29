package ksuid

const (
	offsetUppercase = 10
	offsetLowercase = 36
)

// converts base62 bytes into the number value that it represents.
func base62Value(digit byte) byte {
	switch {
	case digit >= '0' && digit <= '9':
		return digit - '0'
	case digit >= 'A' && digit <= 'Z':
		return offsetUppercase + (digit - 'A')
	default:
		return offsetLowercase + (digit - 'a')
	}
}

func fastDecodeBase62(dst []byte, src []byte) error {
	const srcBase = 62
	const dstBase = 4294967296

	parts := [encodedLen]byte{
		base62Value(src[0]),
		base62Value(src[1]),
		base62Value(src[2]),
		base62Value(src[3]),
		base62Value(src[4]),
		base62Value(src[5]),
		base62Value(src[6]),
		base62Value(src[7]),
		base62Value(src[8]),
		base62Value(src[9]),

		base62Value(src[10]),
		base62Value(src[11]),
		base62Value(src[12]),
		base62Value(src[13]),
		base62Value(src[14]),
		base62Value(src[15]),
		base62Value(src[16]),
		base62Value(src[17]),
		base62Value(src[18]),
		base62Value(src[19]),

		base62Value(src[20]),
		base62Value(src[21]),
		base62Value(src[22]),
		base62Value(src[23]),
		base62Value(src[24]),
		base62Value(src[25]),
		base62Value(src[26]),
		base62Value(src[27]),
		base62Value(src[28]),
	}

	numDst := len(dst)
	baseParts := parts[:]
	baseQueue := [encodedLen]byte{}

	for len(baseParts) > 0 {
		quotient := baseQueue[:0]
		remainder := uint64(0)

		for _, c := range baseParts {
			value := uint64(c) + remainder*srcBase
			digit := value / dstBase
			remainder = value % dstBase

			if len(quotient) != 0 || digit != 0 {
				quotient = append(quotient, byte(digit))
			}
		}

		if numDst < 4 {
			return &ParseError{"output buffer too short"}
		}

		dst[numDst-4] = byte(remainder >> 24)
		dst[numDst-3] = byte(remainder >> 16)
		dst[numDst-2] = byte(remainder >> 8)
		dst[numDst-1] = byte(remainder)
		numDst -= 4
		baseParts = quotient
	}

	var zero [decodedLen]byte
	copy(dst[:numDst], zero[:])
	return nil
}
