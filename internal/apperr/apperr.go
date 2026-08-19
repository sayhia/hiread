// Package apperr is hiread's unified error type. It carries a stable machine
// code (a frontend i18n key) plus optional human-readable detail, and
// serializes to {code, detail} for the frontend.
package apperr

import (
	"errors"
	"fmt"
)

// AppError is an error with a stable code the frontend localizes, plus optional
// detail (the underlying error text). When returned from a Wails service method
// it marshals to {"code": "...", "detail": "..."}.
type AppError struct {
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

func (e *AppError) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

// Code builds a coded error with no extra detail, e.g. Code("alreadySubscribed").
func Code(code string) *AppError { return &AppError{Code: code} }

// Codef builds a coded error with formatted detail.
func Codef(code, format string, args ...any) *AppError {
	return &AppError{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// CodeOf returns err's stable code, or "" if it carries none. For deciding
// between failure modes in Go — "unconfigured" is often an answer to report
// rather than an error to propagate — without matching on message text.
func CodeOf(err error) string {
	var e *AppError
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// Wrap attaches a stable code to an underlying error, preserving its text as
// detail. A nil err yields a bare coded error.
func Wrap(code string, err error) *AppError {
	if err == nil {
		return &AppError{Code: code}
	}
	return &AppError{Code: code, Detail: err.Error()}
}
