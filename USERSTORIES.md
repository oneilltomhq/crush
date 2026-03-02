# User Stories — Career Leverage Agent

> Voice-driven agent that co-pilots career marketing, opportunity discovery, and application tasks.
> Human-in-the-loop: user talks, watches, approves; agent researches, drafts, and acts.

---

## Current System Capabilities (as of 831504f)

| Capability | Status | Notes |
|---|---|---|
| Voice input (STT via Deepgram) | ✅ | User speaks, agent hears |
| Voice output (TTS) | ✅ | Agent speaks back |
| Web search (Tavily) | ✅ | Structured search, clean extraction |
| Deep research (MiniMax M2.5) | ✅ | Plan→parallel-search→synthesize, ~$0.05/report |
| Authenticated browser (auth_browse) | ✅ | Controls user's real Brave with logged-in sessions |
| Headless browser (browse) | ✅ | CDP automation for scraping/reading pages |
| Shell access | ✅ | Full system — git, file I/O, scripts |
| Pane system (3D workspace) | ✅ | Create/remove text, browser, terminal panes |
| File read/write | ✅ | Draft documents, update configs |
| Todo tracking | ✅ | Persistent task list the agent maintains |
| Human-in-the-loop approval | ❌ | Agent acts autonomously — no confirm/reject gate yet |
| Multi-step workflows | ⚠️ | Research tool does multi-step; main agent is single-turn + tools |
| Template/form filling | ❌ | No structured form interaction beyond CDP clicks/typing |
| Image/PDF understanding | ❌ | Can't read screenshots or documents visually |
| OAuth / API integration | ❌ | No LinkedIn API, GitHub API, X API wired up |

---

## Epic 1: Profile & Presence Optimization

### US-1.1 — LinkedIn Profile Update
**As a** freelance engineer, **I want to** say "update my LinkedIn based on this training material" **so that** my profile reflects current best practices for attracting contracts.

**Flow:**
1. User provides training material (file path, URL, or dictates key points)
2. Agent researches current LinkedIn optimization best practices (web_search)
3. Agent reads user's current LinkedIn profile (auth_browse → linkedin.com/in/me)
4. Agent drafts specific edits: headline, about, experience bullets, skills
5. Agent shows draft in a text pane for user review
6. **User approves** (voice: "looks good, do it" / "change the headline to...")
7. Agent applies edits via auth_browse (CDP: click edit, type, save)

**What works today:** Steps 1-5 fully work. Step 6 works (voice input). Step 7 works mechanically (auth_browse + CDP) but is fragile — LinkedIn's DOM changes frequently.

**Gaps:**
- No approval gate — agent would need to be prompted to "show me first" rather than just doing it
- LinkedIn DOM selectors will break; need resilience or a "try and tell me if it fails" pattern
- Training material ingestion: if it's a PDF, we can't read it (text/markdown files work fine)

**Verdict: 🟢 Try it now.** The happy path works with existing tools. Fragility is acceptable for a co-piloted session.

---

### US-1.2 — GitHub Project Showcase
**As a** developer, **I want to** say "review my GitHub projects and suggest which ones to highlight and how to improve their READMEs" **so that** my public repos tell a compelling story.

**Flow:**
1. Agent lists user's public repos (shell: `gh repo list` or web_search github.com/username)
2. Agent reads READMEs and repo metadata for top repos (browse)
3. Agent researches what makes compelling developer portfolios
4. Agent drafts recommendations: which to pin, README improvements, repo descriptions
5. User reviews, approves changes
6. Agent applies via shell (`gh` CLI) or auth_browse

**What works today:** Everything. `gh` CLI is likely available or installable. Shell + browse + research cover this entirely.

**Gaps:**
- Need `gh` CLI authenticated (or use auth_browse on github.com)
- Bulk README rewrites need file write + git commit + push — doable via shell

**Verdict: 🟢 Try it now.**

---

### US-1.3 — X/Twitter Content Strategy
**As a** consultant building a personal brand, **I want to** say "draft a week of X posts about [topic] in my voice" **so that** I maintain a consistent posting cadence without writing from scratch.

**Flow:**
1. Agent researches trending angles on the topic (web_search)
2. Agent reads user's recent posts to learn voice/style (auth_browse → x.com/username)
3. Agent drafts 5-7 posts in a text pane
4. User reviews, edits via voice
5. Agent posts them (auth_browse) or saves as drafts

**What works today:** Steps 1-4 work. Step 5 via auth_browse is possible but X's UI is hostile to automation.

**Gaps:**
- X actively fights automation — CDP typing into compose box is fragile
- Scheduling posts would need X's built-in scheduler UI or a third-party tool
- Better to draft in a file and let user post manually (or use X API with OAuth)

**Verdict: 🟡 Partially. Draft generation works great. Posting is risky — start with drafts-only.**

---

## Epic 2: Target Market & Positioning

### US-2.1 — Identify Your "WHO"
**As a** freelancer, **I want to** say "help me identify my ideal client based on this training material" **so that** I can target my marketing and outreach effectively.

**Flow:**
1. User provides training material (file path or dictates framework)
2. Agent ingests material, extracts the "WHO" framework
3. Agent researches the user's background, past work, skills (from LinkedIn, GitHub, resume)
4. Agent synthesizes: ideal client profile, industries, company sizes, pain points
5. Agent presents analysis in a text pane
6. User refines via conversation
7. Agent saves final WHO document

**What works today:** All of it. This is pure research + synthesis + file output — the system's sweet spot.

**Gaps:**
- Iterative refinement (step 6) requires multi-turn conversation, which works but the agent doesn't maintain state across research runs
- Would benefit from a persistent "profile" document the agent reads at session start

**Verdict: 🟢 Try it now. This is a great first task.**

---

### US-2.2 — Competitive Positioning Research
**As a** freelancer, **I want to** say "research what other [my niche] consultants charge and how they position themselves" **so that** I can price and position competitively.

**Flow:**
1. Agent uses research tool to scan freelancer profiles, rate surveys, blog posts
2. Agent synthesizes findings into a competitive landscape document
3. User reviews and discusses

**What works today:** Fully works — this is exactly what the research pipeline was built for.

**Verdict: 🟢 Try it now.**

---

## Epic 3: Opportunity Discovery & Application

### US-3.1 — Job/Contract Search
**As a** contractor, **I want to** say "find contract opportunities for [my skills] on arc.dev, lemon.io, and general job boards" **so that** I have a pipeline of opportunities.

**Flow:**
1. Agent searches Tavily for current listings matching user's skills
2. Agent browses arc.dev, lemon.io, toptal.com, etc. for relevant listings
3. Agent compiles opportunities with links, rates, requirements
4. Agent presents ranked list in a text pane
5. User says "apply to the first three"

**What works today:** Steps 1-4 work well. Step 5 (applying) depends on the platform.

**Gaps:**
- Some platforms require login to see listings — auth_browse handles this if user is logged in
- Application forms vary wildly — CDP form-filling is possible but fragile per-site
- arc.dev and lemon.io have their own profile systems (see US-3.3)

**Verdict: 🟢 Discovery works now. Application is per-site and needs testing.**

---

### US-3.2 — Resume/Profile Tailoring
**As a** job applicant, **I want to** say "tailor my resume for this role at [company]" **so that** each application is targeted rather than generic.

**Flow:**
1. Agent reads the job posting (browse)
2. Agent reads user's master resume (read_file)
3. Agent researches the company (web_search)
4. Agent drafts a tailored resume emphasizing relevant experience
5. Agent writes to file (write_file) — user reviews
6. User approves or requests changes

**What works today:** All of it. File-based workflow is rock solid.

**Gaps:**
- Resume formatting: agent outputs markdown, user may need PDF. Could shell out to `pandoc` or `wkhtmltopdf`.
- Need a master resume/CV file to start from

**Verdict: 🟢 Try it now. Set up a master resume first.**

---

### US-3.3 — Contracting Platform Profile Setup
**As a** freelancer, **I want to** say "set up my arc.dev profile" **so that** I'm visible to clients on the platform.

**Flow:**
1. Agent reads user's WHO document + resume
2. Agent browses arc.dev profile page (auth_browse)
3. Agent reads profile fields and current state
4. Agent drafts optimized content for each field
5. User approves
6. Agent fills in fields via CDP

**What works today:** Mechanically all possible with auth_browse. Practically fragile — each platform's UI is different.

**Gaps:**
- Each platform needs its own CDP interaction logic
- Better approach might be: agent drafts content, user copy-pastes or agent assists field-by-field

**Verdict: 🟡 Drafting works. Automated filling needs per-platform testing.**

---

## Priority & Sequencing

| # | Story | Effort | Value | Do Now? |
|---|---|---|---|---|
| 1 | US-2.1 WHO Identification | Low | High | ✅ Yes — pure research/synthesis |
| 2 | US-1.1 LinkedIn Profile | Low | High | ✅ Yes — auth_browse exists |
| 3 | US-3.2 Resume Tailoring | Low | High | ✅ Yes — file I/O workflow |
| 4 | US-1.2 GitHub Showcase | Low | Medium | ✅ Yes — shell + browse |
| 5 | US-3.1 Job Search | Low | High | ✅ Yes — research pipeline |
| 6 | US-2.2 Competitive Research | Low | Medium | ✅ Yes — research pipeline |
| 7 | US-1.3 X Content | Medium | Medium | 🟡 Draft only |
| 8 | US-3.3 Platform Profiles | Medium | Medium | 🟡 Draft + assist |

---

## What We Should Build Next (if anything)

Looking at the gaps across all stories, two features would unlock the most:

### Feature A: Human-in-the-Loop Approval Gate
**Problem:** Agent acts immediately. For anything touching live profiles (LinkedIn, X, applications), we need a "here's what I'll do — approve?" step.
**Implementation:** Add a `confirm` tool that pauses execution and waits for user voice input ("yes"/"no"/modifications). The 3D workspace already shows panes — show a diff/preview pane and wait.
**Effort:** ~2-3 hours
**Unlocks:** Safe automated profile edits, form submissions, posts

### Feature B: Persistent User Context
**Problem:** Each session starts cold. Agent doesn't know user's skills, WHO, resume, or past research.
**Implementation:** A `~/.crush/profile/` directory with `resume.md`, `who.md`, `skills.md`, `preferences.md` that the agent reads at session start. Agent tools to update these.
**Effort:** ~1 hour
**Unlocks:** Every story benefits from context — no re-explaining who you are each session

### Not needed yet:
- OAuth API integrations (LinkedIn, X, GitHub APIs) — auth_browse covers us for now
- PDF parsing — ask user to paste text or convert to markdown first
- Form-filling framework — too much abstraction; CDP per-site is fine at this scale

---

## Suggested First Session

**"Help me identify my WHO"** (US-2.1) is the ideal first real task because:
1. Zero fragility — no browser automation on external sites needed
2. Exercises the full voice→research→synthesis pipeline
3. Produces a reusable artifact (WHO document) that feeds into every other story
4. If the user has training material, it tests file ingestion + LLM synthesis
5. Validates the MiniMax M2.5 research model on a real task

After that: LinkedIn profile review (US-1.1) as the first browser-automation test.
