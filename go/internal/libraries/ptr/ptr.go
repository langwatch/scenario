package ptr

// Ptr returns a pointer to the given value.
func Ptr[T any](v T) *T {
	return &v
}

// ValueOrNil returns the value of the pointer if it is not nil, otherwise it returns the
// zero value of the type.
func ValueOrNil[T any](v *T) T {
	if v == nil {
		var zero T
		return zero
	}

	return *v
}

// ValueOrZero returns the value of the pointer if it is not nil, otherwise it returns
// the zero value of the type.
func ValueOrZero[T any](v *T) T {
	if v == nil {
		var zero T
		return zero
	}

	return *v
}

// ValueOrDefault returns the value of the pointer if it is not nil, otherwise it returns
// the zero value of the type.
func ValueOrDefault[T any](v *T, defaultValue T) T {
	if v == nil {
		return defaultValue
	}

	return *v
}
