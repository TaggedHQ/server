package server

// Email notifications for the skill approval loop.
//
// Two moments are worth an email: a self-claimed skill that needs a manager's
// sign-off (the manager cannot act on a queue they do not know about), and the
// manager's decision (the holder cannot see it without opening the page).
//
// Three rules hold for all of them:
//
//   - They are best-effort. A relay that is down, slow or misconfigured must
//     never turn a successful skill assignment into a failed request, so sending
//     happens off the request goroutine and failures are logged, not returned.
//   - They are skipped silently when email is switched off, so a server with no
//     relay behaves exactly as it did before this existed.
//   - They go only to an address in the recipient's profile. The username is a
//     login, not necessarily a mailbox, so it is never used as a fallback.

import (
	"fmt"
	"log"
	"strings"
)

// profileEmail returns the contact address from username's profile, or "" if
// there is none. Errors are treated as "no address": a notification is not worth
// surfacing a storage problem the caller cannot act on.
func (s *Server) profileEmail(username string) string {
	db, err := s.getStore().UserDB(username)
	if err != nil {
		return ""
	}
	defer db.Close()
	return strings.TrimSpace(readProfile(db).Email)
}

// displayName renders the friendliest name we hold for username: their full
// name if the profile carries one, otherwise the username itself.
func (s *Server) displayName(username string) string {
	db, err := s.getStore().UserDB(username)
	if err != nil {
		return username
	}
	defer db.Close()
	p := readProfile(db)
	full := strings.TrimSpace(p.FirstName + " " + p.LastName)
	if full == "" {
		return username
	}
	return full
}

// approversOf lists the accounts that may approve for holder, mirroring
// canManage so the people who get told are exactly the people who can act.
//
// For a holder in a group that is the group's controllers. A holder in no group
// has no controller, and canManage falls back to capSkillsManage; this does the
// same, which means scanning accounts for that capability. That scan is the
// reason this must not run inline on a request -- see notifySkillPending.
func (s *Server) approversOf(holder string) []string {
	if gid := memberGroupOf(s.listGroups(), holder); gid != "" {
		for _, g := range s.listGroups() {
			if g.ID == gid {
				out := make([]string, 0, len(g.Controllers))
				for _, c := range g.Controllers {
					if c != holder { // canManage refuses self-approval
						out = append(out, c)
					}
				}
				return out
			}
		}
		return nil
	}
	metas, err := s.getStore().ListUsers()
	if err != nil {
		return nil
	}
	out := []string{}
	for _, m := range metas {
		if m.Username == holder {
			continue
		}
		db, err := s.getStore().UserDB(m.Username)
		if err != nil {
			continue
		}
		ok := s.capsOf(m.Username, db)[capSkillsManage]
		db.Close()
		if ok {
			out = append(out, m.Username)
		}
	}
	return out
}

// deliver resolves usernames to profile addresses and sends one message.
// Recipients without an address are dropped; if that leaves nobody, nothing is
// sent. It blocks, so callers run it on their own goroutine.
func (s *Server) deliver(to []string, subject, body string) {
	if len(to) == 0 {
		return
	}
	addrs := make([]string, 0, len(to))
	for _, u := range to {
		if addr := s.profileEmail(u); addr != "" {
			addrs = append(addrs, addr)
		}
	}
	if len(addrs) == 0 {
		return
	}
	if err := s.sendMail(addrs, subject, body); err != nil {
		// Named so an operator can tell which notification went missing.
		log.Printf("could not send notification %q: %v", subject, err)
	}
}

// notifySkillPending tells the holder's approvers that a self-claimed skill is
// waiting on them. Everything it needs beyond the two names is looked up in the
// background, because approversOf may scan every account.
func (s *Server) notifySkillPending(holder, skillName string) {
	if !s.mailEnabled() {
		return
	}
	go func() {
		approvers := s.approversOf(holder)
		if len(approvers) == 0 {
			return
		}
		who := s.displayName(holder)
		subject := fmt.Sprintf("Skill approval needed: %s", skillName)
		body := fmt.Sprintf(
			"%s has added the skill %q and it needs your approval.\n\n"+
				"Open Skills in Tagged to approve or reject it.\n",
			who, skillName)
		s.deliver(approvers, subject, body)
	}()
}

// notifySkillDecision tells the holder what their manager decided. A rejection
// says so plainly and points at the way back: the claim can be made again with
// better evidence, which is why rejecting clears it rather than locking it.
func (s *Server) notifySkillDecision(holder, skillName, manager string, approved bool) {
	if !s.mailEnabled() {
		return
	}
	go func() {
		by := s.displayName(manager)
		var subject, body string
		if approved {
			subject = fmt.Sprintf("Skill approved: %s", skillName)
			body = fmt.Sprintf(
				"%s approved your skill %q.\n\nIt is now active on your profile.\n",
				by, skillName)
		} else {
			subject = fmt.Sprintf("Skill rejected: %s", skillName)
			body = fmt.Sprintf(
				"%s did not approve your skill %q.\n\n"+
					"The entry has been removed. You can add it again with more detail "+
					"or supporting evidence.\n",
				by, skillName)
		}
		s.deliver([]string{holder}, subject, body)
	}()
}
