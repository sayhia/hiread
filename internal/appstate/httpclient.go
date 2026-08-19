package appstate

import (
	"net"
	"net/http"
	"net/url"
	"time"
)

// hiread reaches the network for three things only: AI completions, machine
// translation, and downloading reading fonts. All three go through the one
// client built here, so a proxy or timeout the user sets in settings applies to
// everything without an app restart.

// UserAgent identifies hiread to the font CDN and to AI/translation endpoints.
const UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// AcceptLanguage matches what a real browser sends. Some endpoints reject a
// request carrying no Accept-Language at all.
const AcceptLanguage = "en-US,en;q=0.9"

// BuildClient builds an HTTP client (connection pooling, gzip, redirects).
// timeoutSecs bounds the whole request (clamped to [5,300]). proxy is "system"
// (honour HTTP(S)_PROXY env), "none" (bypass), or an explicit proxy URL.
func BuildClient(timeoutSecs int64, proxy string) *http.Client {
	if timeoutSecs < 5 {
		timeoutSecs = 5
	} else if timeoutSecs > 300 {
		timeoutSecs = 300
	}
	tr := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		MaxIdleConns:          50,
		// Per host, net/http keeps only 2 idle connections by default. Chapter
		// translation sends several batches at once to one provider, so with the
		// default the connections past the second are dropped after each wave and
		// re-dialed (TLS handshake and all) for the next. Moot over HTTP/2, where
		// the batches multiplex on one connection — it is the HTTP/1.1 endpoints
		// (a local model, say) that pay.
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	switch proxy {
	case "system", "":
		tr.Proxy = http.ProxyFromEnvironment
	case "none":
		tr.Proxy = nil
	default:
		if u, err := url.Parse(proxy); err == nil {
			tr.Proxy = http.ProxyURL(u)
		}
	}
	return &http.Client{
		Timeout:   time.Duration(timeoutSecs) * time.Second,
		Transport: &uaTransport{base: tr},
	}
}

// uaTransport adds hiread's User-Agent and a default Accept-Language to every
// request that lacks one. Accept-Encoding is intentionally untouched so
// net/http handles gzip transparently.
type uaTransport struct{ base http.RoundTripper }

func (t *uaTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", UserAgent)
	}
	if req.Header.Get("Accept-Language") == "" {
		req.Header.Set("Accept-Language", AcceptLanguage)
	}
	return t.base.RoundTrip(req)
}
