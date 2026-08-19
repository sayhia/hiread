package services

import "testing"

func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.1.0", "0.2.0", true},
		{"0.2.0", "0.1.0", false},
		{"0.1.0", "0.1.0", false},
		{"0.1.0", "0.1.1", true},
		{"0.9.0", "0.10.0", true}, // numeric, not lexicographic
		{"1.2", "1.2.0", false},   // missing segment = 0
		{"1.2", "1.2.1", true},
		{"0.1.0", "0.1.0-rc1", true}, // non-numeric segment falls back to strings
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
