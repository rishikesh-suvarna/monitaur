package metrics

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os/user"
	"slices"
	"strconv"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
)

const (
	// TopProcesses is how many processes are taken by CPU and by memory;
	// their union (at most twice this) is sent (docs/platform-v2.md 6.2).
	TopProcesses = 15
	// MaxCmdLen is the command line length kept, in characters.
	MaxCmdLen = 200
	// MinProcessInterval is the shortest time between two process lists.
	MinProcessInterval = 30 * time.Second

	// maxCachedUsers bounds the uid to name cache; hosts have few users,
	// so hitting it means churn and the cache simply starts over.
	maxCachedUsers = 1024
	percent        = 100
)

// ErrProcessesUnsupported is returned where listing processes would cost too
// much to do every interval.
var ErrProcessesUnsupported = errors.New("process listing is not supported in this build")

// ProcessInterval is how often the process list is sent for a given
// collection interval.
func ProcessInterval(collection time.Duration) time.Duration {
	return max(MinProcessInterval, collection)
}

type ProcessInfo struct {
	PID  int32   `json:"pid"`
	Name string  `json:"name"`
	User string  `json:"user"`
	CPU  float64 `json:"cpu"` // percent of one core since the previous list
	Mem  float64 `json:"mem"` // percent of total memory
	RSS  uint64  `json:"rss"`
	Cmd  string  `json:"cmd"`
}

// ProcessList is the data of a "processes" message.
type ProcessList struct {
	Total     int           `json:"total"`
	Processes []ProcessInfo `json:"processes"`
}

// ProcessCollector lists the busiest processes. It keeps one
// *process.Process per PID across collections because gopsutil computes
// Percent(0) from the CPU times seen by the same object last time: that
// gives CPU use over the whole interval without sleeping. Not safe for
// concurrent use.
type ProcessCollector struct {
	procs map[int32]*process.Process
	users map[uint32]string // gopsutil v4 reports uids as uint32
}

func NewProcessCollector() *ProcessCollector {
	return &ProcessCollector{procs: make(map[int32]*process.Process), users: make(map[uint32]string)}
}

// procSample is what ranking needs; details are read for the winners only.
type procSample struct {
	pid int32
	cpu float64
	rss uint64
}

// Collect returns the union of the top TopProcesses by CPU and by memory.
// The first call only sets the CPU baselines, so its CPU values are 0; call
// it once at startup and send from the second call on. Processes that exit
// while they are read are skipped.
func (pc *ProcessCollector) Collect(ctx context.Context) (*ProcessList, error) {
	if !processesSupported {
		return nil, ErrProcessesUnsupported
	}
	pids, err := process.PidsWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("list processes: %w", err)
	}
	vm, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}

	live := make(map[int32]bool, len(pids))
	samples := make([]procSample, 0, len(pids))
	for _, pid := range pids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		live[pid] = true
		p := pc.procs[pid]
		if p == nil {
			created, err := process.NewProcessWithContext(ctx, pid)
			if err != nil {
				continue // already gone
			}
			p = created
			pc.procs[pid] = p
		}
		cpu, err := p.PercentWithContext(ctx, 0)
		if err != nil {
			delete(pc.procs, pid) // gone or not readable; start fresh if it shows up again
			continue
		}
		mi, err := p.MemoryInfoWithContext(ctx)
		if err != nil {
			delete(pc.procs, pid)
			continue
		}
		samples = append(samples, procSample{pid: pid, cpu: max(cpu, 0), rss: mi.RSS})
	}
	// Forget exited processes, so the map tracks the live set and a PID
	// that gets reused later starts with a fresh baseline.
	for pid := range pc.procs {
		if !live[pid] {
			delete(pc.procs, pid)
		}
	}

	top := topUnion(samples, TopProcesses)
	out := &ProcessList{Total: len(pids), Processes: make([]ProcessInfo, 0, len(top))}
	for _, s := range top {
		p := pc.procs[s.pid]
		name, err := p.NameWithContext(ctx)
		if err != nil {
			continue // exited after it was ranked
		}
		cmd, _ := p.CmdlineWithContext(ctx) // empty for kernel threads and protected processes
		info := ProcessInfo{
			PID: s.pid, Name: name, User: pc.username(ctx, p), CPU: s.cpu, RSS: s.rss,
			Cmd: truncateRunes(cmd, MaxCmdLen),
		}
		if vm.Total > 0 {
			info.Mem = float64(s.rss) / float64(vm.Total) * percent
		}
		out.Processes = append(out.Processes, info)
	}
	return out, nil
}

// username resolves the owner, caching by uid: os/user reads /etc/passwd on
// every lookup when built without cgo. A uid without a name shows as the
// number. Where uids do not exist (Windows), gopsutil asks the process
// token instead, and an owner it cannot read stays empty.
func (pc *ProcessCollector) username(ctx context.Context, p *process.Process) string {
	uids, err := p.UidsWithContext(ctx)
	if err != nil || len(uids) == 0 {
		name, _ := p.UsernameWithContext(ctx)
		return name
	}
	uid := uids[0]
	if name, ok := pc.users[uid]; ok {
		return name
	}
	name := strconv.Itoa(int(uid))
	if u, err := user.LookupId(name); err == nil {
		name = u.Username
	}
	if len(pc.users) >= maxCachedUsers {
		clear(pc.users)
	}
	pc.users[uid] = name
	return name
}

// topUnion returns the top n samples by CPU followed by those of the top n
// by memory not already included. Ties break by the other measure, then by
// PID, so the result is deterministic.
func topUnion(samples []procSample, n int) []procSample {
	byCPU := slices.Clone(samples)
	slices.SortFunc(byCPU, func(a, b procSample) int {
		return cmp.Or(cmp.Compare(b.cpu, a.cpu), cmp.Compare(b.rss, a.rss), cmp.Compare(a.pid, b.pid))
	})
	byMem := slices.Clone(samples)
	slices.SortFunc(byMem, func(a, b procSample) int {
		return cmp.Or(cmp.Compare(b.rss, a.rss), cmp.Compare(b.cpu, a.cpu), cmp.Compare(a.pid, b.pid))
	})

	out := make([]procSample, 0, min(len(samples), 2*n))
	picked := make(map[int32]bool, 2*n)
	for _, list := range [][]procSample{byCPU[:min(n, len(byCPU))], byMem[:min(n, len(byMem))]} {
		for _, s := range list {
			if !picked[s.pid] {
				picked[s.pid] = true
				out = append(out, s)
			}
		}
	}
	return out
}

// truncateRunes cuts s to at most n characters without splitting one.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}
