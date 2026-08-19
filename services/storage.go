package services

import (
	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/events"
	"hiread/internal/models"
)

// StorageService exposes the storage / data-management commands in the settings
// "Advanced" panel.
type StorageService struct {
	app *appstate.State
}

// StorageStats returns database size and library counts.
func (s *StorageService) StorageStats() (models.StorageStats, error) {
	return db.StorageStats(bg(), s.app.DB.R)
}

// VacuumDB reclaims the pages deleted books left behind. It earns its own
// button here because removing one illustrated book can free tens of megabytes
// that SQLite will not hand back to the filesystem on its own.
func (s *StorageService) VacuumDB() error {
	return db.Vacuum(bg(), s.app.DB)
}

// ResetSettings clears every stored setting.
func (s *StorageService) ResetSettings() error {
	return db.ResetSettings(bg(), s.app.DB.W)
}

// ClearLibrary deletes every book — and with it every chapter, highlight,
// bookmark and reading position. Settings, shelves and tags survive.
func (s *StorageService) ClearLibrary() error {
	if err := db.ClearLibrary(bg(), s.app.DB); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}
