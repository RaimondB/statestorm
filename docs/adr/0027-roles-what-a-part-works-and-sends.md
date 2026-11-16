# ADR 0027 — Roles: what a part of the landscape works and sends, whoever plays it

- **Status:** proposed, 2026-11-16
- **Decides:** how a model says which part of the landscape works an activity and which events it
  sends — without naming the app that does it today — and how the overview and the check show an
  event that moves a task worked elsewhere
- **Forced by:** a domain owner: an event comes either from the tasks that move things or from the
  tasks that handle them at a site, since those are different apps; they wanted to see where an event
  is *owned* versus where it completes a task elsewhere — and, on naming the app: today's app could be
  replaced by another solution, which should work as long as it consumes and sends the right set of
  events, and the model must not block that

## Context

ADR 0018 and 0020 place the model's packages in systems, and say which external part sends which
command — narrowed by its payload, so one `Scan` command is the clinic app's for some events and the
courier app's for others. Nothing says which part *works* an activity: that people in one app carry
out the clinic's tasks, and in another the transfer's. So nothing can tell an event that moves a task of
its own side from one that reaches over to the other — and the domain wants to see exactly that.

Naming the app on the activity would tie the model to a vendor's product. What the domain means is a
part of the landscape defined by its contract — the activities worked in it and the events it sends
— which an app fills today and another solution could fill tomorrow.

## Decision

1. **A role** is declared under `roles:`, beside `systems:` (which it needs):

   ```yaml
   roles:
     Collecting:
       note: the clinic's tasks, whatever solution runs them
       works: [SiteVisit]            # these types and their subtypes — and the tasks they hold
       sends:                        # the role's contract: what a solution playing it sends
         - Sample.Scan: { event: [Collected, Packed] }
       receives: [RoutePlanned]      # optional: what it is told
       why: [R7]
   ```

   `sends:` and `receives:` are written as on an external sub-system (ADR 0020 §3–4). A type is worked
   in at most one role — the most specific declaration wins, as the overview's colours do; a command
   sent by two roles with values that can overlap is an error, so an event has one owner.
2. **A sub-system plays a role**: `plays: [Collecting]` on an external sub-system (or an external system
   of one part). It then sends and receives what the role does, beside anything of its own — the
   sequence diagram and the context map see the role's commands as that part's, as before. Replacing
   the app is changing which part plays the role; the model's types, rules and scenarios do not change.
   A role no part plays is a warning: its contract stands, nobody fills it.
3. **An event's owner** is the role whose contract holds the input it comes from — the external
   command at the root of its cause chain (R18): a container's scan passed on to the units inside keeps
   the container scan's owner. An event whose root no role sends — a person's command, a deadline — has
   no owner. **A box's role** is the role its type is worked in, or its nearest drawn ancestor's: a task
   is worked where its activity is.
4. **The overview** marks an event sticky drawn under a box of another role as **from elsewhere**:
   outlined, in its owner's colour — the colour of the first type the role works — with `↗ <role>`; the
   tooltip names the part that sent it. A switch shows only the events from elsewhere. Owned events,
   and any event or box without a role, look as before. **An event that changed nothing of its own role is
   also shown under a box of its own role that answered it without changing** — a task hears its own scan where it happens, though it is
   already under way — so an event never shows only on the other role's side because its own task had
   nothing left to do.
5. **The check** prints a **Roles** section: each role with the parts that play it, and every event
   that moved a box of another role — the event, its owner, the type it moved and that type's role,
   in how many scenarios, with a few named. Information, not a warning: whether a crossing is wrong is
   the domain's to say.

## Consequences

- The kernel parses and checks roles (`systems.ts`), and answers `roleOfCommand` and `roleOfType`; the
  engine is unchanged — a role says where things happen, never what happens.
- A domain can move a contract from one app to another, or split it, by editing `plays:`.
- The table the check prints is built from runs, so it follows the model as it changes; a static
  matrix (which events *could* move which tasks) is not attempted — the runs are what the domain
  argues about.
