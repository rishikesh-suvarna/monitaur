package metrics

import (
	"bufio"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	journalExt      = ".jsonl"
	journalDirPerm  = 0o750
	journalFilePerm = 0o640
	journalBufSize  = 64 << 10
	// journalMaxLine bounds one decoded line. A bucket encodes to ~400 bytes;
	// anything near this size is corruption, not data.
	journalMaxLine = 1 << 20
)

var errJournalClosed = errors.New("metrics journal is closed")

// journal is the crash log for closed buckets (PLAN.md 2.3.2 item 5).
//
// Invariant kept together with Store.pending (both are only appended under
// Store.qmu): every bucket in a journal file is either already written to the
// Sink, still pending, or was dropped on purpose (cap or Forget). That is what
// makes "delete the rotated files after a fully successful flush" safe.
type journal struct {
	dir string
	log *slog.Logger
	now func() time.Time

	mu      sync.Mutex
	f       *os.File
	w       *bufio.Writer
	path    string
	dirty   bool     // appended since the last fsync
	seq     int64    // last file name used; names must be unique even with a frozen test clock
	rotated []string // closed files, oldest first, deleted after a successful flush
	failing bool     // suppresses repeated error logs until the journal recovers
	closed  bool
}

// journalLine is one decoded line: either a Bucket or a Forget tombstone.
type journalLine struct {
	Bucket
	Forget int64 `json:"forget,omitempty"`
}

type journalTombstone struct {
	Forget int64 `json:"forget"`
}

// openJournal creates dir if needed and returns the journal plus any leftover
// files from a previous process, oldest first. Leftovers start out as rotated
// files: they are replayed into pending and deleted after the next good flush.
func openJournal(dir string, now func() time.Time, log *slog.Logger) (*journal, []string, error) {
	if err := os.MkdirAll(dir, journalDirPerm); err != nil {
		return nil, nil, fmt.Errorf("create journal dir: %w", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, fmt.Errorf("list journal dir: %w", err)
	}
	type leftover struct {
		seq  int64
		path string
	}
	var found []leftover
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, journalExt) {
			continue
		}
		seq, err := strconv.ParseInt(strings.TrimSuffix(name, journalExt), 10, 64)
		if err != nil {
			log.Warn("metrics journal: ignoring file with unexpected name", "file", name)
			continue
		}
		found = append(found, leftover{seq: seq, path: filepath.Join(dir, name)})
	}
	slices.SortFunc(found, func(a, b leftover) int { return cmp.Compare(a.seq, b.seq) })

	j := &journal{dir: dir, log: log, now: now}
	paths := make([]string, 0, len(found))
	for _, l := range found {
		paths = append(paths, l.path)
		j.seq = max(j.seq, l.seq)
	}
	j.rotated = slices.Clone(paths)
	return j, paths, nil
}

// readJournalFiles decodes leftover files in order. Malformed lines (a torn
// final write after a crash) are skipped. Duplicates by (server, res, start)
// keep the fuller copy at the position of the first one, and tombstones drop
// every bucket of a forgotten server.
func readJournalFiles(paths []string, log *slog.Logger) ([]Bucket, map[int64]struct{}, error) {
	type key struct {
		server int64
		res    Resolution
		start  int64
	}
	var (
		out       []Bucket
		index     = make(map[key]int)
		forgotten = make(map[int64]struct{})
		skipped   int
	)
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			return nil, nil, fmt.Errorf("open journal file: %w", err)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, journalBufSize), journalMaxLine)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			var rec journalLine
			if err := json.Unmarshal(line, &rec); err != nil {
				skipped++
				continue
			}
			if rec.Forget > 0 {
				forgotten[rec.Forget] = struct{}{}
				continue
			}
			b := rec.Bucket
			if b.ServerID <= 0 || (b.Res != Minute && b.Res != Hour) || b.Start.IsZero() {
				skipped++
				continue
			}
			b.Start = b.Start.UTC()
			k := key{server: b.ServerID, res: b.Res, start: b.Start.Unix()}
			if i, dup := index[k]; dup {
				if b.Samples > out[i].Samples {
					out[i] = b
				}
				continue
			}
			index[k] = len(out)
			out = append(out, b)
		}
		scanErr := sc.Err()
		if err := f.Close(); err != nil {
			log.Warn("metrics journal: close after replay", "file", path, "err", err)
		}
		if scanErr != nil {
			// A line over journalMaxLine is corruption; keep what was read so far.
			log.Warn("metrics journal: stopped reading file early", "file", path, "err", scanErr)
		}
	}
	if skipped > 0 {
		log.Warn("metrics journal: skipped malformed lines", "count", skipped)
	}
	if len(forgotten) > 0 {
		out = slices.DeleteFunc(out, func(b Bucket) bool {
			_, gone := forgotten[b.ServerID]
			return gone
		})
	}
	return out, forgotten, nil
}

// append buffers buckets in the current file. Durability comes from sync,
// which the store calls once per tick, so a burst of closes costs one fsync.
func (j *journal) append(bs []Bucket) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.writeLocked(func(enc *json.Encoder) error {
		for _, b := range bs {
			if err := enc.Encode(b); err != nil {
				return err
			}
		}
		return nil
	})
}

// appendForget records that a server was deleted so a replay does not resend
// its buckets (the rollup tables reference servers, so they would fail).
func (j *journal) appendForget(serverID int64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.writeLocked(func(enc *json.Encoder) error {
		return enc.Encode(journalTombstone{Forget: serverID})
	})
}

func (j *journal) writeLocked(write func(*json.Encoder) error) error {
	if j.closed {
		return errJournalClosed
	}
	if err := j.ensureFileLocked(); err != nil {
		return j.noteErrLocked(err)
	}
	if err := write(json.NewEncoder(j.w)); err != nil {
		j.abandonLocked()
		return j.noteErrLocked(fmt.Errorf("append to journal: %w", err))
	}
	j.dirty = true
	j.noteOKLocked()
	return nil
}

func (j *journal) ensureFileLocked() error {
	if j.f != nil {
		return nil
	}
	j.seq = max(j.seq+1, j.now().UnixNano())
	path := filepath.Join(j.dir, strconv.FormatInt(j.seq, 10)+journalExt)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, journalFilePerm)
	if err != nil {
		return fmt.Errorf("create journal file: %w", err)
	}
	// Persist the directory entry too, or a crash can lose the whole file.
	if err := syncDir(j.dir); err != nil {
		j.log.Warn("metrics journal: fsync dir", "err", err)
	}
	j.f, j.w, j.path = f, bufio.NewWriterSize(f, journalBufSize), path
	return nil
}

// sync flushes buffered appends and fsyncs. The fsync runs without j.mu so a
// slow disk does not stall closers; a concurrent rotate closing the file is
// harmless because rotate fsyncs before closing.
func (j *journal) sync() error {
	j.mu.Lock()
	if !j.dirty || j.f == nil {
		j.mu.Unlock()
		return nil
	}
	if err := j.w.Flush(); err != nil {
		j.abandonLocked()
		err = j.noteErrLocked(fmt.Errorf("flush journal: %w", err))
		j.mu.Unlock()
		return err
	}
	f := j.f
	j.dirty = false
	j.mu.Unlock()

	err := f.Sync()
	if err == nil || errors.Is(err, os.ErrClosed) {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	// After a failed fsync the kernel may have dropped the dirty pages, so the
	// file cannot be trusted for further appends. Start a new one.
	if j.f == f {
		j.abandonLocked()
	}
	return j.noteErrLocked(fmt.Errorf("fsync journal: %w", err))
}

// rotate closes the current file (if any) and returns every rotated file,
// oldest first. Called by Flush under Store.qmu, atomically with the pending
// snapshot.
func (j *journal) rotate() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.finishLocked()
	return slices.Clone(j.rotated)
}

// removeRotated deletes files whose buckets are all written. It stops at the
// first failure so a later tombstone is never deleted before the buckets it
// cancels.
func (j *journal) removeRotated(paths []string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	removed := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			j.log.Error("metrics journal: delete flushed file", "file", p, "err", err)
			break
		}
		removed[p] = struct{}{}
	}
	j.rotated = slices.DeleteFunc(j.rotated, func(p string) bool {
		_, ok := removed[p]
		return ok
	})
}

func (j *journal) close() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.finishLocked()
	j.closed = true
}

// finishLocked flushes, fsyncs and closes the current file and moves it to
// the rotated list. Errors are logged: the file stays on disk for replay.
func (j *journal) finishLocked() {
	if j.f == nil {
		return
	}
	if err := j.w.Flush(); err != nil {
		j.log.Error("metrics journal: flush on rotate", "file", j.path, "err", err)
	}
	if err := j.f.Sync(); err != nil {
		j.log.Error("metrics journal: fsync on rotate", "file", j.path, "err", err)
	}
	j.abandonLocked()
}

// abandonLocked closes the current file without flushing and keeps it for
// replay; whatever reached disk is still valid JSON lines.
func (j *journal) abandonLocked() {
	if j.f == nil {
		return
	}
	if err := j.f.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		j.log.Warn("metrics journal: close file", "file", j.path, "err", err)
	}
	j.rotated = append(j.rotated, j.path)
	j.f, j.w, j.path, j.dirty = nil, nil, "", false
}

func (j *journal) noteErrLocked(err error) error {
	if !j.failing {
		j.log.Error("metrics journal: write failed; buckets stay in memory only until it recovers", "err", err)
		j.failing = true
	}
	return err
}

func (j *journal) noteOKLocked() {
	if j.failing {
		j.log.Info("metrics journal: recovered")
		j.failing = false
	}
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	syncErr := d.Sync()
	closeErr := d.Close()
	return errors.Join(syncErr, closeErr)
}
