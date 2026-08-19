package services

import (
	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/events"
	"hiread/internal/models"
)

// CollectionService exposes shelf CRUD and ordering. A shelf groups books in
// the sidebar; deleting one never deletes the books on it.
type CollectionService struct {
	app *appstate.State
}

// ListCollections returns every shelf with a live book count, ordered for the
// sidebar.
func (s *CollectionService) ListCollections() ([]models.Collection, error) {
	return db.ListCollections(bg(), s.app.DB.R)
}

// CreateCollection creates a shelf (idempotent on name) and returns its id.
func (s *CollectionService) CreateCollection(name string) (int64, error) {
	id, err := db.CreateCollection(bg(), s.app.DB.W, name)
	if err != nil {
		return 0, err
	}
	events.Emit("library-changed", true)
	return id, nil
}

// RenameCollection renames a shelf, rejecting a clash with a different shelf.
func (s *CollectionService) RenameCollection(id int64, name string) error {
	if err := db.RenameCollection(bg(), s.app.DB.W, id, name); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// DeleteCollection removes a shelf; its books stay in the library, unshelved.
func (s *CollectionService) DeleteCollection(id int64) error {
	if err := db.DeleteCollection(bg(), s.app.DB.W, id); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// ReorderCollections persists a new shelf ordering — ids in display order.
func (s *CollectionService) ReorderCollections(ids []int64) error {
	if err := db.ReorderCollections(bg(), s.app.DB, ids); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}
