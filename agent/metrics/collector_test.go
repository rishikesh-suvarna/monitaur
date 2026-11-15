package metrics

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/net"
)

// collectionBudget is the cost one collection must stay well under,
// leaving out the deliberate one-second CPU sampling window.
const collectionBudget = time.Second

func TestIsPhysicalDisk(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"sda", true}, {"sda1", false}, {"sdab", true}, {"sdab12", false},
		{"vda", true}, {"vdb3", false}, {"xvda", true}, {"xvda1", false}, {"hdc", true}, {"hdc3", false},
		{"nvme0n1", true}, {"nvme0n1p1", false}, {"nvme10n2p15", false},
		{"mmcblk0", true}, {"mmcblk0p2", false},
		{"loop0", false}, {"ram0", false}, {"zram0", false}, {"dm-0", false}, {"md127", false},
		{"sr0", false}, {"fd0", false}, {"nbd3", false},
		{"C:", true}, {"disk0", true}, // Windows drive letters, macOS disks
	}
	for _, tc := range tests {
		if got := isPhysicalDisk(tc.name); got != tc.want {
			t.Errorf("isPhysicalDisk(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSumPhysicalDiskIO(t *testing.T) {
	counters := map[string]disk.IOCountersStat{
		"sda":       {ReadBytes: 100, WriteBytes: 10},
		"sda1":      {ReadBytes: 90, WriteBytes: 9}, // already inside sda
		"nvme0n1":   {ReadBytes: 1000, WriteBytes: 500},
		"nvme0n1p1": {ReadBytes: 1000, WriteBytes: 500},
		"dm-0":      {ReadBytes: 1000, WriteBytes: 500}, // LVM on top of nvme0n1
		"loop0":     {ReadBytes: 7, WriteBytes: 7},
	}
	if got := sumPhysicalDiskIO(counters); got != (DiskIOInfo{ReadBytes: 1100, WriteBytes: 510}) {
		t.Fatalf("sum = %+v, want read 1100 write 510", got)
	}
}

func TestSelectMounts(t *testing.T) {
	parts := []disk.PartitionStat{
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
		{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
		{Device: "overlay", Mountpoint: "/var/lib/docker/overlay2/x/merged", Fstype: "overlay"},
		{Device: "/dev/loop3", Mountpoint: "/snap/core/1", Fstype: "squashfs"},
		{Device: "proc", Mountpoint: "/proc", Fstype: "proc"},
		{Device: "server:/export", Mountpoint: "/mnt/nfs", Fstype: "nfs4"},
		{Device: "/dev/sdb1", Mountpoint: "/data", Fstype: "xfs"},
		{Device: "/dev/sda1", Mountpoint: "/var/lib/kubelet/pods/x", Fstype: "ext4"}, // bind mount of /
		{Device: "C:", Mountpoint: "C:", Fstype: "NTFS"},
	}
	var got []string
	for _, p := range selectMounts(parts, MaxMounts) {
		got = append(got, p.Mountpoint)
	}
	if want := []string{"/", "/data", "C:"}; !slices.Equal(got, want) {
		t.Fatalf("mounts = %v, want %v", got, want)
	}

	var many []disk.PartitionStat
	for i := range MaxMounts + 4 {
		many = append(many, disk.PartitionStat{Device: fmt.Sprintf("/dev/sd%c1", 'a'+i), Mountpoint: fmt.Sprintf("/m%d", i), Fstype: "ext4"})
	}
	if got := selectMounts(many, MaxMounts); len(got) != MaxMounts || got[0].Mountpoint != "/m0" {
		t.Fatalf("bounded mounts = %d starting %v, want %d starting /m0", len(got), got[0].Mountpoint, MaxMounts)
	}
}

func TestSelectInterfaces(t *testing.T) {
	tests := []struct {
		name string
		nics []net.IOCountersStat
		want []string
	}{
		{
			name: "loopback dropped on every platform",
			nics: []net.IOCountersStat{{Name: "lo"}, {Name: "wlan0"}, {Name: "lo0"}, {Name: "Loopback Pseudo-Interface 1"}, {Name: "eth0"}, {Name: "lowpan0"}},
			want: []string{"eth0", "lowpan0", "wlan0"},
		},
		{name: "nothing but loopback", nics: []net.IOCountersStat{{Name: "lo"}}, want: []string{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := []string{}
			for _, n := range selectInterfaces(tc.nics, MaxInterfaces) {
				got = append(got, n.Name)
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("interfaces = %v, want %v", got, tc.want)
			}
		})
	}

	// A Docker host: the busiest interfaces win the bounded slots.
	nics := []net.IOCountersStat{{Name: "eth0", BytesRecv: 1 << 40}}
	for i := range MaxInterfaces + 10 {
		nics = append(nics, net.IOCountersStat{Name: fmt.Sprintf("veth%02d", i), BytesSent: uint64(i)})
	}
	got := selectInterfaces(nics, MaxInterfaces)
	if len(got) != MaxInterfaces || !slices.ContainsFunc(got, func(n IfaceInfo) bool { return n.Name == "eth0" }) {
		t.Fatalf("bounded interfaces = %+v, want %d including eth0", got, MaxInterfaces)
	}
	if slices.ContainsFunc(got, func(n IfaceInfo) bool { return n.Name == "veth00" }) {
		t.Fatal("an idle veth took a slot from a busier interface")
	}
	if !slices.IsSortedFunc(got, func(a, b IfaceInfo) int { return strings.Compare(a.Name, b.Name) }) {
		t.Fatal("interfaces not sorted by name")
	}
}

func TestCollectMetricsOnThisHost(t *testing.T) {
	if testing.Short() {
		t.Skip("reads the real host")
	}
	ctx := context.Background()
	c := NewCollector("test")
	m, err := c.CollectMetrics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Mounts) > MaxMounts || len(m.Interfaces) > MaxInterfaces {
		t.Fatalf("lists over bounds: %d mounts, %d interfaces", len(m.Mounts), len(m.Interfaces))
	}
	var sent uint64
	for _, n := range m.Interfaces {
		if loopbackName.MatchString(n.Name) {
			t.Fatalf("loopback %q in interfaces", n.Name)
		}
		sent += n.BytesSent
	}
	if sent > m.Network.BytesSent {
		t.Fatalf("interfaces sent %d bytes, more than the host total %d", sent, m.Network.BytesSent)
	}
	for _, mt := range m.Mounts {
		if !physicalFSTypes[strings.ToLower(mt.FSType)] {
			t.Fatalf("mount %s has non-physical fstype %q", mt.Path, mt.FSType)
		}
	}
	t.Logf("load %+v swap %+v disk_io %+v, %d mounts, %d interfaces", m.Load, m.Swap, m.DiskIO, len(m.Mounts), len(m.Interfaces))
}

// TestCollectionCost measures the work a collection adds on top of the
// one-second CPU sampling window: the F6 sources and a process list.
func TestCollectionCost(t *testing.T) {
	if testing.Short() {
		t.Skip("measures the real host")
	}
	const rounds = 5
	ctx := context.Background()
	c := NewCollector("test")
	pc := NewProcessCollector()
	if _, err := pc.Collect(ctx); err != nil && !errors.Is(err, ErrProcessesUnsupported) {
		t.Fatal(err)
	}

	var worstExt, worstProc time.Duration
	for range rounds {
		start := time.Now()
		var m SystemMetrics
		c.collectExtended(ctx, &m)
		worstExt = max(worstExt, time.Since(start))

		start = time.Now()
		if _, err := pc.Collect(ctx); err != nil && !errors.Is(err, ErrProcessesUnsupported) {
			t.Fatal(err)
		}
		worstProc = max(worstProc, time.Since(start))
	}
	t.Logf("worst of %d: extended host metrics %s, process list %s", rounds, worstExt, worstProc)
	if worstExt+worstProc > collectionBudget {
		t.Fatalf("collection costs %s, budget %s", worstExt+worstProc, collectionBudget)
	}
}

func TestTruncateRunes(t *testing.T) {
	tests := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"exact", 5, "exact"},
		{"postgres -D /var/lib", 8, "postgres"},
		{"日本語のコマンド", 3, "日本語"},
		{"", 5, ""},
	}
	for _, tc := range tests {
		got := truncateRunes(tc.in, tc.n)
		if got != tc.want || !utf8.ValidString(got) {
			t.Errorf("truncateRunes(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}

func BenchmarkCollectExtended(b *testing.B) {
	ctx := context.Background()
	c := NewCollector("bench")
	for b.Loop() {
		var m SystemMetrics
		c.collectExtended(ctx, &m)
	}
}

func BenchmarkProcessCollect(b *testing.B) {
	ctx := context.Background()
	pc := NewProcessCollector()
	if _, err := pc.Collect(ctx); errors.Is(err, ErrProcessesUnsupported) {
		b.Skip(err)
	}
	for b.Loop() {
		if _, err := pc.Collect(ctx); err != nil {
			b.Fatal(err)
		}
	}
}
