// App identity and update check.
//
// Hiread has no packaged update channel yet, so the honest middle ground is a
// real CHECK: ask the repository's release feed whether a newer version
// exists and point the user at the release page. The fetch goes through the
// app HTTP client (proxy settings apply) on the Go side — no CORS, no tokens.
// When a packaged updater lands this file grows the download/install half.

package services

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"hiread/internal/apperr"
)

// appVersion is the running build's version. The release workflow overwrites
// this string before compiling; keep the default in sync with Info.plist.
var appVersion = "0.1.0"

// releaseAPI is the GitHub "latest release" endpoint for the app repository.
const releaseAPI = "https://api.github.com/repos/sunmking/hiread/releases/latest"

// AppInfo identifies this build — the About pane's version line and the
// "copy diagnostics" affordance (version + platform for bug reports).
type AppInfo struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// AppInfo returns the running build's identity.
func (s *SystemService) AppInfo() (*AppInfo, error) {
	return &AppInfo{Version: appVersion, OS: runtime.GOOS, Arch: runtime.GOARCH}, nil
}

// UpdateInfo is the result of an update check.
type UpdateInfo struct {
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	ReleaseURL string `json:"releaseUrl"`
	HasUpdate  bool   `json:"hasUpdate"`
}

// CheckForUpdate asks the repository's release feed for the newest published
// version. A repository with no releases yet reports up-to-date rather than
// erroring — that is the normal state until the first packaged release.
func (s *SystemService) CheckForUpdate() (*UpdateInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releaseAPI, nil)
	if err != nil {
		return nil, apperr.Wrap("network", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := s.app.HTTP().Do(req)
	if err != nil {
		return nil, apperr.Wrap("network", err)
	}
	defer resp.Body.Close()

	info := &UpdateInfo{Current: appVersion, Latest: appVersion}
	if resp.StatusCode == http.StatusNotFound {
		return info, nil // no releases published yet
	}
	if resp.StatusCode != http.StatusOK {
		return nil, apperr.Codef("network", "HTTP %d", resp.StatusCode)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return nil, apperr.Wrap("network", err)
	}
	latest := strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v")
	if latest == "" {
		return info, nil
	}
	info.Latest = latest
	info.ReleaseURL = rel.HTMLURL
	info.HasUpdate = versionLess(appVersion, latest)
	return info, nil
}

// versionLess reports whether a < b for dotted versions ("0.1.0" < "0.2.0").
// Segments compare numerically when both parse, as strings otherwise; a
// missing segment counts as zero ("1.2" == "1.2.0").
func versionLess(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	n := max(len(as), len(bs))
	for i := 0; i < n; i++ {
		av, bv := "0", "0"
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		an, aerr := strconv.Atoi(av)
		bn, berr := strconv.Atoi(bv)
		if aerr == nil && berr == nil {
			if an != bn {
				return an < bn
			}
			continue
		}
		if av != bv {
			return av < bv
		}
	}
	return false
}
