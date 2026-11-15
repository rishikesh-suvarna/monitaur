//go:build darwin && !cgo

package metrics

// Without cgo, gopsutil reads a process's CPU times and memory on macOS by
// running ps once per process and value, which would mean hundreds of
// fork/execs every list. Release builds cross-compile with cgo off, so they
// skip process lists rather than load the host they monitor.
const processesSupported = false
