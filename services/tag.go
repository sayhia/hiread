package services

import (
	"strings"

	"hiread/internal/apperr"
	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/models"
)

// TagService exposes tag CRUD, ordering, and book tagging.
type TagService struct {
	app *appstate.State
}

// ListTags returns every tag with a live book count, ordered for the sidebar.
func (s *TagService) ListTags() ([]models.Tag, error) {
	return db.ListTags(bg(), s.app.DB.R)
}

// CreateTag creates a tag (idempotent on name) and returns its id. An
// empty/whitespace-only name is rejected at this chokepoint.
func (s *TagService) CreateTag(name string) (int64, error) {
	if strings.TrimSpace(name) == "" {
		return 0, apperr.Code("emptyTagName")
	}
	return db.CreateTag(bg(), s.app.DB.W, name)
}

// RenameTag renames a tag, rejecting a clash with a different tag.
func (s *TagService) RenameTag(id int64, name string) error {
	return db.RenameTag(bg(), s.app.DB.W, id, name)
}

// SetTagColor changes a tag's colour (a palette key).
func (s *TagService) SetTagColor(id int64, color string) error {
	return db.SetTagColor(bg(), s.app.DB.W, id, color)
}

// DeleteTag removes a tag; its book links cascade.
func (s *TagService) DeleteTag(id int64) error {
	return db.DeleteTag(bg(), s.app.DB.W, id)
}

// ReorderTags persists a new tag ordering — ids in the desired display order.
func (s *TagService) ReorderTags(ids []int64) error {
	return db.ReorderTags(bg(), s.app.DB, ids)
}

// SetBookTag attaches (on = true) or detaches a tag from one book.
func (s *TagService) SetBookTag(bookID, tagID int64, on bool) error {
	return db.SetBookTag(bg(), s.app.DB.W, bookID, tagID, on)
}
