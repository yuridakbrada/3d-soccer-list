(() => {
  const $ = (id) => document.getElementById(id);
  const configured = window.SUPABASE_URL && !window.SUPABASE_URL.includes("YOUR-PROJECT")
    && window.SUPABASE_ANON_KEY && !window.SUPABASE_ANON_KEY.includes("YOUR_");
  const db = configured && window.supabase
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : null;

  let mode = "login";
  let currentUser = null;
  let currentProfile = null;
  const authDialog = $("authDialog");
  const profileDialog = $("profileDialog");
  const adminDialog = $("adminDialog");

  function message(id, text, isError = false) {
    const el = $(id);
    if (el) { el.textContent = text; el.style.color = isError ? "#ff8e8e" : "var(--accent)"; }
  }
  function setAuthMode(next) {
    mode = next;
    $("authTitle").innerHTML = mode === "signup" ? "Create <em>account.</em>" : "Welcome <em>back.</em>";
    $("authEyebrow").textContent = mode === "signup" ? "JOIN THE COMPETITION" : "PLAYER ACCOUNT";
    $("authSubmit").textContent = mode === "signup" ? "Create account" : "Log in";
    $("usernameField").classList.toggle("hidden", mode !== "signup");
    $("usernameField").querySelector("input").required = mode === "signup";
    $("authSwitch").textContent = mode === "signup" ? "Already have an account? Log in" : "Need an account? Sign up";
    $("authForm").elements.password.autocomplete = mode === "signup" ? "new-password" : "current-password";
    message("authMessage", "");
  }
  function showSignedIn(profile) {
    currentProfile = profile || currentProfile;
    $("loginOpen").classList.add("hidden");
    $("signupOpen").classList.add("hidden");
    $("accountButton").classList.remove("hidden");
    $("accountButton").textContent = currentProfile?.username || currentUser?.email || "My account";
  }
  function showSignedOut() {
    $("adminOpen").classList.add("hidden");
    currentUser = null; currentProfile = null;
    $("loginOpen").classList.remove("hidden");
    $("signupOpen").classList.remove("hidden");
    $("accountButton").classList.add("hidden");
  }
  async function loadProfile() {
    if (!db || !currentUser) return;
    const { data, error } = await db.from("profiles").select("id, username, display_name, bio, points, division, wins, losses, avatar_url, banner_url").eq("id", currentUser.id).maybeSingle();
    if (error) { console.error(error); return; }
    currentProfile = data;
    if (data) showSignedIn(data);
  }
  async function checkAdmin() {
    if (!db || !currentUser) { $("adminOpen").classList.add("hidden"); return; }
    const { data, error } = await db.rpc("is_admin");
    if (error) { console.error("Admin check failed:", error); $("adminOpen").classList.add("hidden"); return; }
    $("adminOpen").classList.toggle("hidden", data !== true);
  }
  async function loadAdminSubmissions() {
    const target = $("adminSubmissions");
    target.innerHTML = '<p class="muted">Loading submissions...</p>';
    const { data, error } = await db.from("match_submissions").select("id, opponent_username, submitter_score, opponent_score, evidence_url, notes, created_at, profiles(username)").eq("status", "pending").order("created_at", { ascending: true });
    if (error) { target.textContent = "Could not load submissions: " + error.message; return; }
    if (!data?.length) { target.innerHTML = '<p class="muted">No pending submissions.</p>'; return; }
    target.innerHTML = data.map(item => `<article class="admin-submission"><strong>@${escapeHtml(item.profiles?.username || "unknown")}</strong> vs <strong>@${escapeHtml(item.opponent_username)}</strong><br>Score: ${item.submitter_score}–${item.opponent_score}<br><a href="${escapeHtml(item.evidence_url)}" target="_blank" rel="noopener noreferrer">Open evidence</a>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}<small class="muted">${new Date(item.created_at).toLocaleString()}</small></article>`).join("");
  }
  async function refreshSession() {
    if (!db) return;
    const { data } = await db.auth.getSession();
    currentUser = data.session?.user || null;
    if (currentUser) { await loadProfile(); if (!currentProfile) showSignedIn(null); await checkAdmin(); }
    else showSignedOut();
  }
  async function loadRanking() {
    if (!db) return;
    const { data, error } = await db.from("public_ranking").select("*").order("points", { ascending: false }).limit(200);
    if (error) { $("rankingStatus").textContent = "Could not load ranking. Check the Supabase schema and permissions."; console.error(error); return; }
    renderRanking(data || []);
    $("rankingStatus").textContent = (data?.length || 0) + " ranked players";
  }
  function renderRanking(rows) {
    const q = $("playerSearch").value.trim().toLowerCase();
    const division = $("divisionFilter").value;
    const filtered = rows.filter(p => (p.username || "").toLowerCase().includes(q) && (!division || p.division === division));
    $("rankingRows").innerHTML = filtered.length ? filtered.map((p, i) =>
      `<tr><td>${i + 1}</td><td><strong>${escapeHtml(p.display_name || p.username)}</strong><div class="muted tiny">@${escapeHtml(p.username)}</div></td><td>${escapeHtml(p.division)}</td><td><strong>${Number(p.points).toLocaleString()}</strong></td><td>${p.wins || 0}-${p.losses || 0}</td></tr>`
    ).join("") : '<tr><td colspan="5" class="empty">No players found.</td></tr>';
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }

  $("loginOpen").addEventListener("click", () => { setAuthMode("login"); authDialog.showModal(); });
  $("signupOpen").addEventListener("click", () => { setAuthMode("signup"); authDialog.showModal(); });
  $("authSwitch").addEventListener("click", () => setAuthMode(mode === "login" ? "signup" : "login"));
  $("accountButton").addEventListener("click", async () => {
    if (!currentUser) return;
    $("profileTitle").innerHTML = `<em>@${escapeHtml(currentProfile?.username || "player")}</em>`;
    $("profileContent").innerHTML = currentProfile
      ? `<div class="profile-stat"><b>${Number(currentProfile.points).toLocaleString()} points</b> · ${escapeHtml(currentProfile.division)}</div><p>${escapeHtml(currentProfile.bio || "No biography yet.")}</p><p class="muted small">Wins: ${currentProfile.wins || 0} · Losses: ${currentProfile.losses || 0}</p>`
      : '<p class="muted">Your profile is being prepared.</p>';
    profileDialog.showModal();
  });
  $("adminOpen").addEventListener("click", async () => { await loadAdminSubmissions(); adminDialog.showModal(); });
  $("logoutButton").addEventListener("click", async () => {
    if (db) await db.auth.signOut();
    profileDialog.close(); showSignedOut();
  });
  $("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!db) return message("authMessage", "Supabase is not configured yet. Follow the setup instructions in README.md.", true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    const password = String(form.get("password"));
    message("authMessage", "Please wait...");
    if (mode === "signup") {
      const username = String(form.get("username")).trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return message("authMessage", "Username: 3–24 characters, letters, numbers and underscores only.", true);
      const { data, error } = await db.auth.signUp({ email, password, options: { data: { username }, emailRedirectTo: "https://yuridakbrada.github.io/3d-soccer-list/" } });
      if (error) return message("authMessage", error.message, true);
      if (data.session) { currentUser = data.user; await loadProfile(); authDialog.close(); }
      else message("authMessage", "Account created. Check your email to confirm your address, then log in.");
    } else {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) return message("authMessage", error.message, true);
      currentUser = data.user; await loadProfile(); await checkAdmin(); authDialog.close(); showSignedIn(currentProfile);
    }
  });
  $("matchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!db) return message("matchMessage", "The database is not configured yet. Please try again after setup.", true);
    if (!currentUser) { setAuthMode("login"); authDialog.showModal(); return message("authMessage", "Log in before submitting a match."); }
    const form = new FormData(event.currentTarget);
    const yourScore = Number(form.get("your_score"));
    const opponentScore = Number(form.get("opponent_score"));
    if (yourScore === opponentScore) return message("matchMessage", "Draws are not supported by the current points rules.", true);
    message("matchMessage", "Submitting...");
    const { error } = await db.from("match_submissions").insert({
      submitted_by: currentUser.id,
      opponent_username: String(form.get("opponent")).trim().toLowerCase(),
      submitter_score: yourScore,
      opponent_score: opponentScore,
      evidence_url: String(form.get("evidence_url")).trim(),
      notes: String(form.get("notes") || "").trim() || null
    });
    if (error) return message("matchMessage", error.message, true);
    event.currentTarget.reset();
    message("matchMessage", "Match submitted for review. Your points will change only after staff approval.");
  });

  $("playerSearch").addEventListener("input", loadRanking);
  $("divisionFilter").addEventListener("change", loadRanking);
  $("mobileMenu").addEventListener("click", () => $("navigation").classList.toggle("open"));
  $("navigation").querySelectorAll("a").forEach(a => a.addEventListener("click", () => $("navigation").classList.remove("open")));

  if (db) {
    db.auth.onAuthStateChange((_event, session) => {
      currentUser = session?.user || null;
      if (!currentUser) showSignedOut();
      else setTimeout(async () => { await loadProfile(); await checkAdmin(); showSignedIn(currentProfile); }, 0);
    });
    refreshSession(); loadRanking();
  } else {
    $("rankingStatus").textContent = "Setup required: connect a Supabase project to activate accounts and the live leaderboard.";
    message("matchMessage", "Database connection is not configured yet.");
  }
})();