package server

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// Throttling for credential checks. Passwords and TOTP codes are both guessable
// given enough attempts -- a TOTP code is six digits and three of them are valid
// at any moment, so an unlimited guesser gets through a second factor in hours.
//
// Attempts are charged against two keys: the account being tried, and the
// client address. The account key is the real protection; the address key only
// slows an attacker spraying many accounts, and so is deliberately far more
// generous, because one address legitimately carries a whole office.
//
// The limiter is in-memory on purpose: this server is a single process, and a
// limiter that needed the database would add a write to every failed login.

const (
	// userBurst is how many failures one account may accumulate before it locks.
	userBurst = 8
	// ipBurst is the same for a client address. An office behind one NAT should
	// never reach it by ordinary mistyping.
	ipBurst = 60
	// loginRefill is how long one charged failure takes to age out, so a locked
	// key recovers a further attempt every interval rather than staying dead.
	loginRefill = 30 * time.Second
	// loginMaxAge is when an idle key is forgotten, keeping the map bounded.
	loginMaxAge = time.Hour
	// sweepAt is how many keys must pile up before an insert prunes stale ones.
	sweepAt = 1024
)

type limiterEntry struct {
	failures float64
	seen     time.Time
}

type rateLimiter struct {
	mu   sync.Mutex
	keys map[string]*limiterEntry
	// now is swappable so the tests do not have to sleep.
	now func() time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{keys: map[string]*limiterEntry{}, now: time.Now}
}

// allow reports whether key is still under burst. It only reads state -- a
// successful login must not be charged, so the caller records failures.
func (l *rateLimiter) allow(key string, burst float64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.keys[key]
	if e == nil {
		return true
	}
	return l.decayed(e) < burst
}

// fail charges one failure against key. The running count is capped just above
// burst so a sustained attack cannot push recovery out indefinitely: once the
// attacker stops, the key frees up after at most burst+1 refill intervals. The
// cap has to sit above burst rather than on it -- decay always shaves a little
// off, so a count pinned exactly at burst would read as under the limit and the
// key would never lock at all.
func (l *rateLimiter) fail(key string, burst float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e := l.keys[key]
	if e == nil {
		e = &limiterEntry{}
		l.keys[key] = e
		l.sweepLocked(now)
	}
	f := l.decayed(e) + 1
	if f > burst+1 {
		f = burst + 1
	}
	e.failures = f
	e.seen = now
}

// reset clears a key, called when an attempt finally succeeds so a legitimate
// user who mistyped a few times is not left throttled.
func (l *rateLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.keys, key)
}

// decayed is e.failures reduced by however many refill intervals have passed.
// Caller holds the lock.
func (l *rateLimiter) decayed(e *limiterEntry) float64 {
	elapsed := l.now().Sub(e.seen)
	if elapsed <= 0 {
		return e.failures
	}
	f := e.failures - elapsed.Seconds()/loginRefill.Seconds()
	if f < 0 {
		return 0
	}
	return f
}

// sweepLocked drops entries nothing has touched for loginMaxAge, so a long
// running server does not accumulate one map entry per attempted username.
func (l *rateLimiter) sweepLocked(now time.Time) {
	if len(l.keys) < sweepAt {
		return
	}
	for k, e := range l.keys {
		if now.Sub(e.seen) > loginMaxAge {
			delete(l.keys, k)
		}
	}
}

// limiterIP identifies the client for throttling.
//
// Behind a reverse proxy every request arrives from the proxy's own address, so
// keying on the peer would put the whole user base in one bucket and let a
// single attacker lock everyone out. When the peer is a configured trusted
// proxy we therefore take the forwarded client instead, and when that is
// missing we return "" -- no address key at all, leaving the per-account limit
// to do the work. Guessing here would be worse than not keying on an address.
func (s *Server) limiterIP(r *http.Request) string {
	peer := clientIP(r)
	if s.trusted != nil && s.trusted.contains(peer) {
		return firstForwarded(r.Header.Get("X-Forwarded-For"))
	}
	return peer
}

// firstForwarded returns the left-most address in an X-Forwarded-For list, the
// one the trusted proxy saw as the client.
func firstForwarded(header string) string {
	first, _, _ := strings.Cut(header, ",")
	return strings.TrimSpace(first)
}

// loginBudget pairs each key with the burst it is allowed.
type loginBudget struct {
	key   string
	burst float64
}

func loginBudgets(username, ip string) []loginBudget {
	out := []loginBudget{{"user:" + username, userBurst}}
	if ip != "" {
		out = append(out, loginBudget{"ip:" + ip, ipBurst})
	}
	return out
}

// allowLogin reports whether a credential check may run at all.
func (s *Server) allowLogin(username, ip string) bool {
	for _, b := range loginBudgets(username, ip) {
		if !s.loginLimit.allow(b.key, b.burst) {
			return false
		}
	}
	return true
}

// noteLoginFailure charges a failed credential check.
func (s *Server) noteLoginFailure(username, ip string) {
	for _, b := range loginBudgets(username, ip) {
		s.loginLimit.fail(b.key, b.burst)
	}
}

// noteLoginSuccess clears the counters behind a successful login.
func (s *Server) noteLoginSuccess(username, ip string) {
	for _, b := range loginBudgets(username, ip) {
		s.loginLimit.reset(b.key)
	}
}
