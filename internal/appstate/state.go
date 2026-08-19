// Package appstate holds the process-wide shared state every Wails service
// reads from: the database pools and the HTTP client (rebuildable when proxy /
// timeout settings change).
package appstate

import (
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"hiread/internal/db"
)

// State is shared by all services. It is created once at startup and handed to
// each service via a pointer, so they all see the same database and HTTP client.
type State struct {
	DB      *db.DB
	dataDir string

	httpMu sync.RWMutex
	http   *http.Client
}

// New opens the database under dataDir and builds a default HTTP client. The
// caller is responsible for calling Close at shutdown.
func New(dataDir string) (*State, error) {
	database, err := db.Open(filepath.Join(dataDir, "hiread.db"))
	if err != nil {
		return nil, err
	}
	return &State{
		DB:      database,
		dataDir: dataDir,
		http:    defaultClient(),
	}, nil
}

// defaultClient is the HTTP client used until network settings are applied.
func defaultClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

// Close releases the database pools.
func (s *State) Close() error {
	if s.DB != nil {
		return s.DB.Close()
	}
	return nil
}

// DataDir is the application data directory (where the database lives).
func (s *State) DataDir() string { return s.dataDir }

// HTTP returns the current HTTP client. Safe to call concurrently with
// SetHTTP; the returned client may be swapped out by a later settings change,
// but an in-flight request keeps using the client it started with.
func (s *State) HTTP() *http.Client {
	s.httpMu.RLock()
	defer s.httpMu.RUnlock()
	return s.http
}

// SetHTTP swaps in a freshly built HTTP client (e.g. after the user changes the
// proxy or request timeout), without an app restart.
func (s *State) SetHTTP(c *http.Client) {
	s.httpMu.Lock()
	defer s.httpMu.Unlock()
	s.http = c
}
