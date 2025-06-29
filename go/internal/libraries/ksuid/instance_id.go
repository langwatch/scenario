package ksuid

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
)

var (
	ErrNoHardwareAddress = errors.New("no hardware address")
	ErrNotDockerized     = errors.New("not dockerized")
)

type InstanceID struct {
	SchemeData byte
	BytesData  [8]byte
}

func (i InstanceID) Scheme() byte {
	return i.SchemeData
}

func (i InstanceID) Bytes() [8]byte {
	return i.BytesData
}

// NewHardwareID returns a HardwareID for the current node.
func NewHardwareID(ctx context.Context) (InstanceID, error) {
	hwAddr, err := getHardwareAddr(ctx)
	if err != nil {
		return InstanceID{}, err
	}

	//nolint:gosec // we're intentionally truncating to 16 bits
	processID := uint16(os.Getpid() & 0xFFFF)

	var bytes [8]byte
	copy(bytes[:], hwAddr)
	binary.BigEndian.PutUint16(bytes[6:], processID)

	return InstanceID{
		SchemeData: 'H',
		BytesData:  bytes,
	}, nil
}

func getHardwareAddr(ctx context.Context) (net.HardwareAddr, error) {
	addrs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	for _, addr := range addrs {
		// only return physical interfaces (i.e. not loopback)
		if len(addr.HardwareAddr) >= 6 {
			return addr.HardwareAddr, nil
		}
	}

	return nil, fmt.Errorf("%w: %w", ErrNoHardwareAddress, err)
}

// NewDockerID returns a DockerID for the current Docker container.
func NewDockerID(ctx context.Context) (InstanceID, error) {
	cid, err := getDockerID(ctx)
	if err != nil {
		return InstanceID{}, err
	}

	var b [8]byte
	copy(b[:], cid)

	return InstanceID{
		SchemeData: 'D',
		BytesData:  b,
	}, nil
}

func getDockerID(ctx context.Context) ([]byte, error) {
	src, err := os.ReadFile("/proc/1/cpuset")
	src = bytes.TrimSpace(src)
	if os.IsNotExist(err) || len(src) < 64 || !bytes.HasPrefix(src, []byte("/docker")) {
		return nil, fmt.Errorf("%w: %w", ErrNotDockerized, err)
	} else if err != nil {
		return nil, err
	}

	dst := make([]byte, 32)
	_, err = hex.Decode(dst, src[len(src)-64:])
	if err != nil {
		return nil, err
	}

	return dst, nil
}

// NewRandomID returns a RandomID initialized by a PRNG.
func NewRandomID() InstanceID {
	tmp := make([]byte, 8)
	if _, err := rand.Read(tmp); err != nil {
		panic(err)
	}

	var b [8]byte
	copy(b[:], tmp)

	return InstanceID{
		SchemeData: 'R',
		BytesData:  b,
	}
}
