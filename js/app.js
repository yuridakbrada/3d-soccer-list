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
  let rankingPage = 0;
  const rankingPageSize = 25;
  let rankingTotal = 0;
  const authDialog = $("authDialog");
  const profileDialog = $("profileDialog");
  const adminDialog = $("adminDialog");
  const profileEditForm = $("profileEditForm");

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
    const q = $("playerSearch").value.trim();
    const division = $("divisionFilter").value;
    let query = db.from("public_ranking").select("*", { count: "exact" });
    if (q) query = query.ilike("username", "%" + q.replace(/[%_,]/g, "") + "%");
    if (division) query = query.eq("division", division);
    const from = rankingPage * rankingPageSize;
    const { data, error, count } = await query.order("points", { ascending: false }).order("username", { ascending: true }).range(from, from + rankingPageSize - 1);
    if (error) { $("rankingStatus").textContent = "Could not load ranking. Check the Supabase schema and permissions."; console.error(error); return; }
    rankingTotal = count || 0;
    renderRanking(data || []);
    const pages = Math.max(1, Math.ceil(rankingTotal / rankingPageSize));
    $("rankingStatus").textContent = rankingTotal + " ranked players · showing " + (rankingTotal ? from + 1 : 0) + "–" + Math.min(from + rankingPageSize, rankingTotal);
    $("rankingPageLabel").textContent = "Page " + (rankingPage + 1) + " of " + pages;
    $("rankingPrev").disabled = rankingPage === 0;
    $("rankingNext").disabled = rankingPage + 1 >= pages;
  }
  function renderRanking(rows) {
    $("rankingRows").innerHTML = rows.length ? rows.map((p, i) => {
      const avatar = p.avatar_url
        ? '<img class="ranking-avatar" src="' + escapeHtml(p.avatar_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
        : '<span class="ranking-avatar ranking-avatar-fallback" aria-hidden="true">' + escapeHtml((p.display_name || p.username || "?").charAt(0).toUpperCase()) + '</span>';
      return '<tr class="ranking-player-row"><td>' + (rankingPage * rankingPageSize + i + 1) + '</td><td><button class="ranking-player" type="button" data-player-id="' + escapeHtml(p.id) + '">' + avatar + '<span class="ranking-name"><strong>' + escapeHtml(p.display_name || p.username) + '</strong>' + divisionBadge(p) + '<span class="muted tiny">@' + escapeHtml(p.username) + '</span></span></button></td><td>' + escapeHtml(p.division) + '</td><td><strong>' + Number(p.points).toLocaleString() + '</strong></td><td>' + (p.wins || 0) + '-' + (p.losses || 0) + '</td></tr>';
    }).join("") : '<tr><td colspan="5" class="empty">No players found.</td></tr>';
  }
  const divisionMeta = [
    { name: "Beginner", code: "BG", color: "#92979e" },
    { name: "Intermediate", code: "IN", color: "#b87945" },
    { name: "Advanced", code: "AD", color: "#b9c2cc" },
    { name: "Professional", code: "PR", color: "#d6ad35" },
    { name: "Legend", code: "LG", color: "#55bde8" },
    { name: "Master", code: "MA", color: "#36a879" },
    { name: "Professor", code: "PF", color: "#d34b62" }
  ];
  function getDivisionMeta(profile) {
    const points = Number(profile?.points || 0);
    const index = points <= 500 ? 0 : points <= 1000 ? 1 : points <= 1500 ? 2 :
      points <= 2000 ? 3 : points <= 3000 ? 4 : points <= 4000 ? 5 : 6;
    return divisionMeta[index];
  }
  function divisionBadge(profile) {
    const division = getDivisionMeta(profile);
    return '<span class="division-badge" style="--division-color:' + division.color +
      '" title="' + division.name + '" aria-label="' + division.name + '">' + division.code + '</span>';
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }

  $("loginOpen").addEventListener("click", () => { setAuthMode("login"); authDialog.showModal(); });
  $("signupOpen").addEventListener("click", () => { setAuthMode("signup"); authDialog.showModal(); });
  $("authSwitch").addEventListener("click", () => setAuthMode(mode === "login" ? "signup" : "login"));
  $("accountButton").addEventListener("click", async () => {
    if (!currentUser) return;
    renderProfile();
    profileEditForm.classList.add("hidden");
    $("editProfileOpen").classList.remove("hidden");
    profileDialog.showModal();
  });
  function renderProfile(profile = currentProfile) {
    const viewedProfile = profile;
    const isOwnProfile = !!currentUser && !!viewedProfile && currentUser.id === viewedProfile.id;
    $("editProfileOpen").classList.toggle("hidden", !isOwnProfile);
    $("logoutButton").classList.toggle("hidden", !isOwnProfile);
    $("profileTitle").innerHTML = '<em>@' + escapeHtml(viewedProfile?.username || "player") + '</em>';
    if (!viewedProfile) {
      $("profileContent").innerHTML = '<p class="muted">Profile unavailable.</p>';
      return;
    }
    const banner = viewedProfile.banner_url ? '<img class="profile-banner" src="' + escapeHtml(viewedProfile.banner_url) + '" alt="Profile banner" referrerpolicy="no-referrer">' : "";
    const avatar = viewedProfile.avatar_url ? '<img class="profile-avatar" src="' + escapeHtml(viewedProfile.avatar_url) + '" alt="Profile avatar" referrerpolicy="no-referrer">' : "";
    $("profileContent").innerHTML = banner + '<div class="profile-identity">' + avatar + '<div><div class="profile-name-line"><strong>' + escapeHtml(viewedProfile.display_name || viewedProfile.username) + '</strong>' + divisionBadge(viewedProfile) + '</div><div class="muted tiny">@' + escapeHtml(viewedProfile.username) + '</div></div></div><div class="profile-stat"><b>' + Number(viewedProfile.points).toLocaleString() + ' points</b> · ' + escapeHtml(viewedProfile.division) + '</div><p>' + escapeHtml(viewedProfile.bio || "No biography yet.") + '</p><p class="muted small">Wins: ' + (viewedProfile.wins || 0) + ' · Losses: ' + (viewedProfile.losses || 0) + '</p>';
  }
  async function openPlayerProfile(playerId) {
    if (!db) return;
    if (currentUser?.id === playerId && currentProfile) {
      renderProfile(currentProfile);
      profileEditForm.classList.add("hidden");
      profileDialog.showModal();
      return;
    }
    const { data, error } = await db.from("profiles").select("id, username, display_name, bio, points, division, wins, losses, avatar_url, banner_url").eq("id", playerId).maybeSingle();
    if (error || !data) { console.error(error); return; }
    renderProfile(data);
    profileEditForm.classList.add("hidden");
    profileDialog.showModal();
  }
  $("rankingRows").addEventListener("click", event => {
    const button = event.target.closest("[data-player-id]");
    if (button) openPlayerProfile(button.dataset.playerId);
  });
  $("editProfileOpen").addEventListener("click", () => {
    profileEditForm.elements.display_name.value = currentProfile?.display_name || "";
    profileEditForm.elements.bio.value = currentProfile?.bio || "";
    profileEditForm.elements.avatar_url.value = currentProfile?.avatar_url || "";
    profileEditForm.elements.banner_url.value = currentProfile?.banner_url || "";
    profileEditForm.classList.remove("hidden");
    $("editProfileOpen").classList.add("hidden");
    message("profileEditMessage", "");
  });
  $("profileEditCancel").addEventListener("click", () => {
    profileEditForm.classList.add("hidden");
    $("editProfileOpen").classList.remove("hidden");
    message("profileEditMessage", "");
  });
  profileEditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!db || !currentUser) return message("profileEditMessage", "Please log in again.", true);
    const form = new FormData(profileEditForm);
    const displayName = String(form.get("display_name") || "").trim();
    const bio = String(form.get("bio") || "").trim();
    const avatarUrl = String(form.get("avatar_url") || "").trim();
    const bannerUrl = String(form.get("banner_url") || "").trim();
    if (!displayName) return message("profileEditMessage", "Display name is required.", true);
    for (const value of [avatarUrl, bannerUrl]) {
      if (value && !/^https?:\/\//i.test(value)) return message("profileEditMessage", "Image URLs must begin with http:// or https://.", true);
    }
    $("profileSave").disabled = true;
    message("profileEditMessage", "Saving...");
    const { error } = await db.from("profiles").update({
      display_name: displayName, bio,
      avatar_url: avatarUrl || null, banner_url: bannerUrl || null
    }).eq("id", currentUser.id);
    $("profileSave").disabled = false;
    if (error) return message("profileEditMessage", error.message, true);
    await loadProfile();
    renderProfile();
    profileEditForm.classList.add("hidden");
    $("editProfileOpen").classList.remove("hidden");
    message("profileEditMessage", "Profile updated successfully.");
    loadRanking();
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

  $("playerSearch").addEventListener("input", () => { rankingPage = 0; loadRanking(); });
  $("divisionFilter").addEventListener("change", () => { rankingPage = 0; loadRanking(); });
  $("rankingPrev").addEventListener("click", () => { if (rankingPage > 0) { rankingPage--; loadRanking(); } });
  $("rankingNext").addEventListener("click", () => { if ((rankingPage + 1) * rankingPageSize < rankingTotal) { rankingPage++; loadRanking(); } });
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