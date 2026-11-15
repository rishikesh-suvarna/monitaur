package directory_test

import (
	"testing"

	"backend/directory"
	"backend/store"
)

func TestMaintenanceWriteThrough(t *testing.T) {
	dir := directory.New(nil)
	w := store.MaintenanceWindow{ID: 1, OrgID: 1, Name: "a", ScopeAll: true}
	dir.PutMaintenance(w)
	before := dir.OrgMaintenance(1)

	w.Name = "renamed"
	dir.PutMaintenance(w)
	dir.PutMaintenance(store.MaintenanceWindow{ID: 2, OrgID: 1, Name: "b"})
	if got := dir.OrgMaintenance(1); len(got) != 2 {
		t.Fatalf("windows = %+v, want 2", got)
	}
	if got, ok := dir.OrgMaintenanceWindow(1, 1); !ok || got.Name != "renamed" {
		t.Fatalf("window 1 = %+v, %v", got, ok)
	}
	// Readers hold the old slice without a lock: writes must not touch it.
	if len(before) != 1 || before[0].Name != "a" {
		t.Fatalf("earlier read changed under the reader: %+v", before)
	}
	if _, ok := dir.OrgMaintenanceWindow(2, 1); ok {
		t.Fatal("window visible from another org")
	}
	dir.RemoveMaintenance(1, 1)
	dir.RemoveMaintenance(1, 2)
	if got := dir.OrgMaintenance(1); len(got) != 0 {
		t.Fatalf("windows after remove = %+v", got)
	}
}
