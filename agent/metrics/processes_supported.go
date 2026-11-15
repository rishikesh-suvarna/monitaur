package metrics

// gopsutil v4 reads process CPU and memory on macOS without cgo (no ps per
// process; about 35 ms for ~670 processes), so cgo-free release builds list
// processes on every platform. Kept as a constant so a platform that cannot
// list processes cheaply can opt out with a build-tagged file.
const processesSupported = true
