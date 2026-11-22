(() => {
  const $ = (id) => document.getElementById(id);
  const configured = window.SUPABASE_URL && !window.SUPABASE_URL.includes("YOUR-PROJECT")
    && window.SUPABASE_ANON_KEY && !window.SUPABASE_ANON_KEY.includes("YOUR_");
  let db = null;
  let dbInitError = null;
  if (configured && window.supabase?.createClient) {
    try {
      db = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    } catch (error) {
      dbInitError = error;
      console.error("Supabase initialization failed:", error);
    }
  } else if (configured) {
    dbInitError = new Error("Supabase JavaScript library did not load.");
    console.error(dbInitError);
  }

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
  function updateAccountButton() {
    const button = $("accountButton");
    const profile = currentProfile;
    const label = profile?.display_name || profile?.username || currentUser?.email || "My account";
    const initials = (profile?.display_name || profile?.username || currentUser?.email || "?")
      .trim().charAt(0).toUpperCase();
    button.replaceChildren();
    button.title = label;
    button.setAttribute("aria-label", "Open profile: " + label);
    if (profile?.avatar_url) {
      const avatar = document.createElement("img");
      avatar.className = "account-avatar";
      avatar.src = profile.avatar_url;
      avatar.alt = "";
      avatar.referrerPolicy = "no-referrer";
      avatar.onerror = () => {
        const fallback = document.createElement("span");
        fallback.className = "account-avatar-fallback";
        fallback.textContent = initials;
        button.replaceChildren(fallback);
      };
      button.append(avatar);
    } else {
      const fallback = document.createElement("span");
      fallback.className = "account-avatar-fallback";
      fallback.textContent = initials;
      button.append(fallback);
    }
  }
  function showSignedIn(profile) {
    currentProfile = profile || currentProfile;
    $("loginOpen").classList.add("hidden");
    $("signupOpen").classList.add("hidden");
    $("accountButton").classList.remove("hidden");
    $("matchRequestsOpen").classList.remove("hidden");
    updateAccountButton();
  }
  function showSignedOut() {
    $("adminOpen").classList.add("hidden");
    currentUser = null; currentProfile = null;
    $("loginOpen").classList.remove("hidden");
    $("signupOpen").classList.remove("hidden");
    $("accountButton").classList.add("hidden");
    $("matchRequestsOpen").classList.add("hidden");
  }
  async function loadProfile() {
    if (!db || !currentUser) return;
    const { data, error } = await db.from("profiles").select("id, username, display_name, bio, points, division, wins, losses, avatar_url, banner_url, dm_policy, match_policy").eq("id", currentUser.id).maybeSingle();
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
    const { data, error } = await db.from("match_submissions")
      .select("id, opponent_username, submitter_score, opponent_score, evidence_url, notes, created_at, profiles(username,display_name,points,division)")
      .eq("status", "pending").order("created_at", { ascending: true });
    if (error) { target.textContent = "Could not load submissions: " + error.message; return; }
    if (!data?.length) { target.innerHTML = '<p class="muted">No pending submissions.</p>'; return; }
    target.innerHTML = data.map(item => `
      <article class="admin-submission">
        <div class="admin-submission-heading"><strong>@${escapeHtml(item.profiles?.username || "unknown")}</strong> vs <strong>@${escapeHtml(item.opponent_username)}</strong></div>
        <p class="admin-submission-score">Score: <strong>${item.submitter_score}–${item.opponent_score}</strong></p>
        <p class="muted small">Submitter: ${Number(item.profiles?.points ?? 0).toLocaleString()} pts · ${escapeHtml(item.profiles?.division || "Unknown division")}</p>
        <a href="${escapeHtml(item.evidence_url)}" target="_blank" rel="noopener noreferrer">Open evidence ↗</a>
        ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
        <small class="muted">${new Date(item.created_at).toLocaleString()}</small>
        <div class="admin-review-actions">
          <button class="button button-primary" type="button" data-review-action="approve" data-submission-id="${escapeHtml(item.id)}">Approve</button>
          <button class="button button-ghost" type="button" data-review-action="reject" data-submission-id="${escapeHtml(item.id)}">Reject</button>
        </div>
      </article>`).join("");
  }
  $("adminSubmissions").addEventListener("click", async event => {
    const button = event.target.closest("[data-review-action]");
    if (!button || !currentUser) return;
    const approve = button.dataset.reviewAction === "approve";
    const action = approve ? "approve" : "reject";
    if (!window.confirm(`Are you sure you want to ${action} this match submission?`)) return;
    const card = button.closest(".admin-submission");
    card?.querySelectorAll("button").forEach(control => { control.disabled = true; });
    const { error } = await db.rpc("review_match_submission", {
      p_submission_id: button.dataset.submissionId,
      p_approve: approve,
      p_review_note: null
    });
    if (error) {
      if (card) {
        const status = document.createElement("p");
        status.className = "form-message";
        status.textContent = "Could not " + action + ": " + error.message;
        card.append(status);
        card.querySelectorAll("button").forEach(control => { control.disabled = false; });
      }
      return;
    }
    await loadAdminSubmissions();
    await loadRanking();
  });
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
      return '<tr class="ranking-player-row"><td>' + (rankingPage * rankingPageSize + i + 1) + '</td><td><button class="ranking-player" type="button" data-player-id="' + escapeHtml(p.id) + '">' + avatar + '<span class="ranking-name"><span class="ranking-name-main"><strong>' + escapeHtml(p.display_name || p.username) + '</strong>' + divisionBadge(p) + '</span><span class="muted tiny">@' + escapeHtml(p.username) + '</span></span></button></td><td>' + escapeHtml(p.division) + '</td><td><strong>' + Number(p.points).toLocaleString() + '</strong></td><td>' + (p.wins || 0) + '-' + (p.losses || 0) + '</td></tr>';
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
    loadProfileExtras(currentProfile);
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
    $("profileContent").innerHTML = banner + '<div class="profile-identity">' + avatar + '<div><div class="profile-name-line"><span class="profile-name-main"><strong>' + escapeHtml(viewedProfile.display_name || viewedProfile.username) + '</strong>' + divisionBadge(viewedProfile) + '</span></div><div class="muted tiny">@' + escapeHtml(viewedProfile.username) + '</div></div></div><div class="profile-stat"><b>' + Number(viewedProfile.points).toLocaleString() + ' points</b> · ' + escapeHtml(viewedProfile.division) + '</div><p>' + escapeHtml(viewedProfile.bio || "No biography yet.") + '</p><p class="muted small">Wins: ' + (viewedProfile.wins || 0) + ' · Losses: ' + (viewedProfile.losses || 0) + '</p><div id="profileStreams" class="profile-streams"></div><div id="profileActions" class="profile-actions"></div><section class="profile-match-section"><h3>Recent matches</h3><div id="profileMatches" class="profile-matches"><p class="muted small">Loading recent matches...</p></div></section>';
  }
  async function openPlayerProfile(playerId) {
    if (!db) return;
    if (currentUser?.id === playerId && currentProfile) {
      renderProfile(currentProfile);
      loadProfileExtras(currentProfile);
      profileEditForm.classList.add("hidden");
      profileDialog.showModal();
      return;
    }
    const { data, error } = await db.from("profiles").select("id, username, display_name, bio, points, division, wins, losses, avatar_url, banner_url, dm_policy").eq("id", playerId).maybeSingle();
    if (error || !data) { console.error(error); return; }
    renderProfile(data);
    loadProfileExtras(data);
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
    profileEditForm.elements.dm_policy.value = currentProfile?.dm_policy || "everyone";
    profileEditForm.elements.match_policy.value = currentProfile?.match_policy || "everyone";
    loadOwnStreamsIntoForm();
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
      avatar_url: avatarUrl || null, banner_url: bannerUrl || null,
      dm_policy: String(form.get("dm_policy") || "everyone"),
      match_policy: String(form.get("match_policy") || "everyone")
    }).eq("id", currentUser.id);
    $("profileSave").disabled = false;
    if (error) return message("profileEditMessage", error.message, true);
    await loadProfile();
    await saveOwnStreams(form);
    renderProfile();
    loadProfileExtras(currentProfile);
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
    if (!db) return message("authMessage", dbInitError ? "Could not connect to the login service. Reload the page and check the browser console." : "Supabase is not configured yet. Follow the setup instructions in README.md.", true);
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


  // ---------- Community: profile history, friends, DMs, groups, clans ----------
  let activeConversationId = null;
  let activeConversationTitle = "";
  let chatSubscription = null;
  let activeProfileId = null;
  let matchRequestSubscription = null;
  const communityDialog = $("communityDialog");
  const chatDialog = $("chatDialog");

  async function loadProfileExtras(profile) {
    if (!db || !profile) return;
    activeProfileId = profile.id;
    const matchBox = $("profileMatches");
    const streamBox = $("profileStreams");
    const actionBox = $("profileActions");
    if (matchBox) {
      const { data, error } = await db.from("public_player_matches")
        .select("id,opponent_username,player_score,opponent_score,points_change,result,created_at")
        .eq("player_id", profile.id).order("created_at", { ascending: false }).limit(10);
      if (error) matchBox.innerHTML = '<p class="muted small">Could not load match history.</p>';
      else if (!data?.length) matchBox.innerHTML = '<p class="muted small">No approved matches yet.</p>';
      else matchBox.innerHTML = data.map(m => '<article class="profile-match"><span class="match-result ' + (m.result === "win" ? "match-win" : "match-loss") + '">' + (m.result === "win" ? "W" : "L") + '</span><span><b>vs @' + escapeHtml(m.opponent_username) + '</b><small>' + Number(m.player_score) + '–' + Number(m.opponent_score) + ' · ' + new Date(m.created_at).toLocaleDateString() + '</small></span><strong>' + (m.points_change > 0 ? "+" : "") + Number(m.points_change) + ' pts</strong></article>').join("");
    }
    if (streamBox) {
      const { data } = await db.from("player_streams").select("platform,url").eq("user_id", profile.id);
      streamBox.innerHTML = data?.length ? '<div class="stream-links">' + data.map(x => '<a target="_blank" rel="noopener noreferrer" href="' + escapeHtml(x.url) + '">' + escapeHtml(x.platform.toUpperCase()) + ' ↗</a>').join("") + '</div>' : "";
    }
    if (actionBox) {
      if (currentUser?.id === profile.id) {
        actionBox.innerHTML = '<span class="muted small">DM privacy: ' + ({nobody:"Not accepting DMs",friends:"Friends only",everyone:"Everyone"}[profile.dm_policy || "everyone"]) + '</span>';
      } else if (!currentUser) {
        actionBox.innerHTML = '<button class="button button-outline" type="button" data-profile-login>Log in to connect</button>';
      } else {
        const { data: friends } = await db.rpc("are_friends", {p_user_a:currentUser.id,p_user_b:profile.id});
        const { data: pending } = await db.from("friend_requests").select("id,requester_id,addressee_id,status")
          .or('and(requester_id.eq.' + currentUser.id + ',addressee_id.eq.' + profile.id + '),and(requester_id.eq.' + profile.id + ',addressee_id.eq.' + currentUser.id + ')').eq("status","pending").limit(1);
        const dmAllowed = profile.dm_policy === "everyone" || (profile.dm_policy === "friends" && friends === true);
        actionBox.innerHTML = (friends ? '<span class="muted small">Friends</span>' : pending?.length ? '<span class="muted small">Friend request pending</span>' : '<button class="button button-outline" type="button" data-add-friend="' + escapeHtml(profile.id) + '">Add friend</button>') +
          (dmAllowed ? '<button class="button button-primary" type="button" data-message-player="' + escapeHtml(profile.id) + '">Message</button>' : '<span class="muted small">' + (profile.dm_policy === "nobody" ? "This player is not accepting DMs." : "Add each other as friends to send a DM.") + '</span>');
      }
    }
  }

  async function loadOwnStreamsIntoForm() {
    if (!db || !currentUser) return;
    const { data } = await db.from("player_streams").select("platform,url").eq("user_id",currentUser.id);
    for (const platform of ["youtube","twitch","kick"]) {
      const input = profileEditForm.elements["stream_" + platform];
      if (input) input.value = data?.find(x => x.platform === platform)?.url || "";
    }
  }

  async function saveOwnStreams(form) {
    if (!db || !currentUser) return;
    for (const platform of ["youtube","twitch","kick"]) {
      const url = String(form.get("stream_" + platform) || "").trim();
      if (!url) {
        await db.from("player_streams").delete().eq("user_id",currentUser.id).eq("platform",platform);
      } else {
        const { error } = await db.from("player_streams").upsert({user_id:currentUser.id,platform,url},{onConflict:"user_id,platform"});
        if (error) console.error("Could not save " + platform + " link:",error);
      }
    }
  }

  async function startDirectMessage(playerId) {
    if (!currentUser) { setAuthMode("login"); authDialog.showModal(); return; }
    const { data, error } = await db.rpc("create_conversation",{p_member_ids:[playerId],p_title:null});
    if (error) { alert(error.message); return; }
    profileDialog.close();
    await openChat(data,"Direct message");
  }

  async function openChat(conversationId,title) {
    activeConversationId = conversationId;
    activeConversationTitle = title || "Conversation";
    $("chatTitle").textContent = activeConversationTitle;
    $("chatMessages").innerHTML = '<p class="muted small">Loading messages...</p>';
    chatDialog.showModal();
    await loadChatMessages();
    if (chatSubscription) { await db.removeChannel(chatSubscription); chatSubscription=null; }
    chatSubscription=db.channel("chat-"+conversationId)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"messages",filter:"conversation_id=eq."+conversationId},()=>loadChatMessages())
      .subscribe();
  }
  chatDialog.addEventListener("close",()=>{if(chatSubscription&&db){db.removeChannel(chatSubscription);chatSubscription=null;}});

  async function loadChatMessages() {
    if (!db || !activeConversationId) return;
    const { data,error } = await db.from("messages").select("id,sender_id,body,created_at").eq("conversation_id",activeConversationId).order("created_at",{ascending:true}).limit(100);
    if (error) { $("chatMessages").textContent = error.message; return; }
    $("chatMessages").innerHTML = data?.length ? data.map(m => '<article class="chat-message ' + (m.sender_id===currentUser.id?"chat-mine":"") + '"><p>' + escapeHtml(m.body) + '</p><small>' + new Date(m.created_at).toLocaleString() + '</small></article>').join("") : '<p class="muted small">No messages yet. Start the conversation.</p>';
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  }

  $("chatForm").addEventListener("submit",async event=>{
    event.preventDefault();
    if (!currentUser || !activeConversationId) return;
    const body=String(new FormData(event.currentTarget).get("body")||"").trim();
    if (!body) return;
    const {error}=await db.from("messages").insert({conversation_id:activeConversationId,sender_id:currentUser.id,body});
    if (error) { message("chatStatus",error.message,true); return; }
    event.currentTarget.reset(); message("chatStatus",""); await loadChatMessages();
  });

  async function showCommunity(section="messages") {
    if (!currentUser) { setAuthMode("login"); authDialog.showModal(); return; }
    $("communityTitle").textContent = section==="clans"?"Clans":section==="ranking"?"Clan ranking":section==="friends"?"Friends":section==="match-requests"?"Match challenges":"Messages";
    $("communityContent").innerHTML = '<p class="muted">Loading...</p>';
    communityDialog.showModal();
    if (section==="messages") await renderConversations();
    if (section==="match-requests") await renderMatchRequests();
    if (section==="friends") await renderFriends();
    if (section==="clans") await renderClans();
    if (section==="ranking") await renderClanRanking();
  }

  async function renderConversations() {
    const {data,error}=await db.from("conversation_participants")
      .select("conversation_id,conversations(id,title,conversation_type,created_at)")
      .eq("user_id",currentUser.id).order("joined_at",{ascending:false});
    if (error) { $("communityContent").textContent=error.message; return; }
    const rows=(data||[]).map(x=>x.conversations).filter(Boolean);
    $("communityContent").innerHTML='<div class="community-actions"><button class="button button-outline" data-community="friends">Friends</button><button class="button button-outline" data-community="match-requests">Match requests</button><button class="button button-outline" data-community="new-group">Create group</button></div>' +
      (rows.length?rows.map(c=>'<button class="conversation-row" data-open-chat="' + c.id + '" data-chat-title="' + escapeHtml(c.title || "Direct message") + '"><span><b>' + escapeHtml(c.title || "Direct message") + '</b><small>' + (c.conversation_type==="group"?"Group":"Private chat") + '</small></span><span>Open →</span></button>').join(""):'<p class="muted small">No conversations yet. Open a player profile and choose Message.</p>');
  }

  async function renderFriends() {
    const {data,error}=await db.from("friend_requests").select("id,requester_id,addressee_id,status,created_at,requester:profiles!friend_requests_requester_id_fkey(username,display_name),addressee:profiles!friend_requests_addressee_id_fkey(username,display_name)")
      .or('requester_id.eq.'+currentUser.id+',addressee_id.eq.'+currentUser.id).order("created_at",{ascending:false});
    if (error) { $("communityContent").textContent=error.message; return; }
    const incoming=(data||[]).filter(x=>x.addressee_id===currentUser.id&&x.status==="pending");
    const friends=(data||[]).filter(x=>x.status==="accepted");
    const outgoing=(data||[]).filter(x=>x.requester_id===currentUser.id&&x.status==="pending");
    $("communityContent").innerHTML='<div class="community-actions"><button class="button button-outline" data-community="messages">Messages</button><button class="button button-outline" data-community="match-requests">Match requests</button></div><h3>Friend requests</h3>' +
      (incoming.length?incoming.map(x=>'<article class="community-row"><span>@'+escapeHtml(x.requester?.username||"player")+'</span><span><button class="button button-primary" data-friend-response="'+x.id+'" data-accept="true">Accept</button> <button class="button button-outline" data-friend-response="'+x.id+'" data-accept="false">Decline</button></span></article>').join(""):'<p class="muted small">No incoming requests.</p>')+
      '<h3>Your friends</h3>'+(friends.length?friends.map(x=>'<article class="community-row"><b>@'+escapeHtml((x.requester_id===currentUser.id?x.addressee:x.requester)?.username||"player")+'</b><span>Friends</span></article>').join(""):'<p class="muted small">No friends added yet.</p>')+
      (outgoing.length?'<p class="muted small">Outgoing requests: '+outgoing.length+'</p>':'');
  }

  async function renderClans() {
    const {data:my,error:myError}=await db.from("clan_members").select("clan_id,member_role,clans(id,name,slug,description)").eq("user_id",currentUser.id).maybeSingle();
    if (myError) { $("communityContent").textContent=myError.message; return; }
    const {data:clans,error}=await db.from("clan_ranking").select("*").order("points",{ascending:false}).limit(50);
    if (error) { $("communityContent").textContent=error.message; return; }
    let html='<div class="community-actions"><button class="button button-outline" data-community="ranking">Clan ranking</button></div>';
    const {data:invites}=await db.from("clan_invites").select("id,clans(name)").eq("invited_user_id",currentUser.id).eq("status","pending");
    if(invites?.length) html+='<h3>Clan invitations</h3>'+invites.map(x=>'<article class="community-row"><b>'+escapeHtml(x.clans?.name||"Clan")+'</b><span><button class="button button-primary" data-clan-invite="'+x.id+'" data-accept="true">Accept</button> <button class="button button-outline" data-clan-invite="'+x.id+'" data-accept="false">Decline</button></span></article>').join("");
    if (!my) html+='<form id="createClanForm" class="inline-form"><h3>Create a clan</h3><input name="name" required minlength="3" maxlength="32" placeholder="Clan name"><textarea name="description" maxlength="500" placeholder="Description"></textarea><button class="button button-primary">Create clan</button></form>';
    else {
      html+='<section class="my-clan"><h3>'+escapeHtml(my.clans?.name||"Your clan")+'</h3><p class="muted small">'+escapeHtml(my.clans?.description||"")+'</p><p>Your role: '+escapeHtml(my.member_role)+'</p><button class="button button-outline" data-leave-clan>Leave clan</button></section>';
      const {data:members}=await db.from("clan_members").select("user_id,member_role,profiles(username,display_name,points)").eq("clan_id",my.clan_id);
      html+='<h3>Roster ('+(members?.length||0)+'/4)</h3>'+(members||[]).map(m=>'<article class="community-row"><span>@'+escapeHtml(m.profiles?.username||"player")+' · '+escapeHtml(m.member_role)+'</span><span><b>'+Number(m.profiles?.points||0)+' pts</b>'+(my.member_role==="leader"&&m.user_id!==currentUser.id?' <button class="button button-outline" data-set-vice="'+m.user_id+'">Make vice</button> <button class="button button-outline" data-remove-member="'+m.user_id+'">Remove</button>':'')+'</span></article>').join("");
      if(my.member_role==="leader") html+='<form id="inviteClanForm" class="inline-form"><h3>Invite a player</h3><input name="username" required placeholder="Player username"><button class="button button-primary">Send invitation</button></form>';
      if (my.member_role==="leader"||my.member_role==="vice_leader") {
        const {data:reqs}=await db.from("clan_join_requests").select("id,user_id,profiles(username)").eq("clan_id",my.clan_id).eq("status","pending");
        html+='<h3>Join requests</h3>'+(reqs?.length?reqs.map(r=>'<article class="community-row"><span>@'+escapeHtml(r.profiles?.username||"player")+'</span><button class="button button-primary" data-clan-request="'+r.id+'">Accept</button></article>').join(""):'<p class="muted small">No pending requests.</p>');
      }
    }
    html+='<h3>Explore clans</h3>'+(clans||[]).map(c=>'<article class="community-row"><span><b><button class="link-button" data-view-clan="'+c.id+'">'+escapeHtml(c.name)+'</button></b><small>'+Number(c.member_count)+' / 4 members · '+Number(c.points)+' pts</small></span>'+(my?'':'<button class="button button-outline" data-join-clan="'+c.id+'">Request to join</button>')+'</article>').join("");
    $("communityContent").innerHTML=html;
  }

  async function renderClanRanking() {
    const {data,error}=await db.from("clan_ranking").select("*").order("points",{ascending:false}).limit(100);
    if (error) { $("communityContent").textContent=error.message; return; }
    $("communityContent").innerHTML='<div class="community-actions"><button class="button button-outline" data-community="clans">Back to clans</button></div><div class="clan-ranking-list">'+(data||[]).map((c,i)=>'<article class="community-row"><span><b>#'+(i+1)+' <button class="link-button" data-view-clan="'+c.id+'">'+escapeHtml(c.name)+'</button></b><small>'+Number(c.member_count)+'/4 players</small></span><strong>'+Number(c.points).toLocaleString()+' pts</strong></article>').join("")+'</div>';
  }


  async function showPublicClan(clanId) {
    const {data:clan,error}=await db.from("clans").select("id,name,slug,description,logo_url,banner_url").eq("id",clanId).maybeSingle();
    if(error||!clan) return alert("Clan page could not be loaded.");
    const {data:members}=await db.from("clan_members").select("user_id,member_role,profiles(username,points)").eq("clan_id",clanId);
    $("communityTitle").textContent=clan.name;
    $("communityContent").innerHTML=(clan.banner_url?'<img class="profile-banner" src="'+escapeHtml(clan.banner_url)+'" alt="">':'')+
      '<div class="community-actions"><button class="button button-outline" data-community="clans">Back</button></div><h3>'+escapeHtml(clan.name)+'</h3><p>'+escapeHtml(clan.description||"No description.")+'</p><p class="muted small">Public clan page · '+(members?.length||0)+'/4 members</p>'+
      (members||[]).map(m=>'<article class="community-row"><span><b>@'+escapeHtml(m.profiles?.username||"player")+'</b><small>'+escapeHtml(m.member_role)+'</small></span><strong>'+Number(m.profiles?.points||0)+' pts</strong></article>').join("");
    if(currentUser && !(members||[]).some(m=>m.user_id===currentUser.id)) $("communityContent").insertAdjacentHTML("beforeend",'<button class="button button-primary" data-join-clan="'+clan.id+'">Request to join</button>');
    communityDialog.showModal();
  }

  $("profileContent").addEventListener("click",async event=>{
    const dm=event.target.closest("[data-message-player]");
    const add=event.target.closest("[data-add-friend]");
    const login=event.target.closest("[data-profile-login]");
    if (dm) await startDirectMessage(dm.dataset.messagePlayer);
    if (add) {
      const {error}=await db.rpc("send_friend_request",{p_user_id:add.dataset.addFriend});
      if (error) alert(error.message); else { alert("Friend request sent."); if (activeProfileId) { const {data}=await db.from("profiles").select("id,username,display_name,dm_policy").eq("id",activeProfileId).single(); if(data) loadProfileExtras(data); } }
    }
    if (login) { setAuthMode("login"); authDialog.showModal(); }
  });

  $("communityContent").addEventListener("click",async event=>{
    const community=event.target.closest("[data-community]");
    const open=event.target.closest("[data-open-chat]");
    const response=event.target.closest("[data-friend-response]");
    const join=event.target.closest("[data-join-clan]");
    const accept=event.target.closest("[data-clan-request]");
    const leave=event.target.closest("[data-leave-clan]");
    const invite=event.target.closest("[data-clan-invite]");
    const remove=event.target.closest("[data-remove-member]");
    const vice=event.target.closest("[data-set-vice]");
    const viewClan=event.target.closest("[data-view-clan]");
    if (community) {
      if (community.dataset.community==="new-group") {
        $("communityContent").innerHTML='<form id="newGroupForm" class="inline-form"><h3>New group</h3><input name="title" required maxlength="60" placeholder="Group name"><textarea name="usernames" required placeholder="Player usernames, separated by commas"></textarea><button class="button button-primary">Create group</button></form>';
      } else await showCommunity(community.dataset.community);
    }
    if (open) await openChat(open.dataset.openChat,open.dataset.chatTitle);
    if (viewClan) await showPublicClan(viewClan.dataset.viewClan);
    if (invite) {
      const {error}=await db.rpc("respond_clan_invite",{p_invite_id:invite.dataset.clanInvite,p_accept:invite.dataset.accept==="true"});
      if(error) alert(error.message); else await renderClans();
    }
    if (remove && confirm("Remove this player from the clan?")) {
      const {data:mine}=await db.from("clan_members").select("clan_id").eq("user_id",currentUser.id).maybeSingle();
      const {error}=await db.rpc("remove_clan_member",{p_clan_id:mine.clan_id,p_user_id:remove.dataset.removeMember});
      if(error) alert(error.message); else await renderClans();
    }
    if (vice) {
      const {data:mine}=await db.from("clan_members").select("clan_id").eq("user_id",currentUser.id).maybeSingle();
      const {error}=await db.rpc("set_clan_vice_leader",{p_clan_id:mine.clan_id,p_user_id:vice.dataset.setVice});
      if(error) alert(error.message); else await renderClans();
    }
    if (response) {
      const {error}=await db.rpc("respond_friend_request",{p_request_id:response.dataset.friendResponse,p_accept:response.dataset.accept==="true"});
      if(error) alert(error.message); else await renderFriends();
    }
    if (join) {
      const {error}=await db.rpc("request_clan_join",{p_clan_id:join.dataset.joinClan});
      if(error) alert(error.message); else { alert("Join request sent."); await renderClans(); }
    }
    if (accept) {
      const {error}=await db.rpc("review_clan_join_request",{p_request_id:accept.dataset.clanRequest,p_accept:true});
      if(error) alert(error.message); else await renderClans();
    }
    if (leave && confirm("Leave your current clan?")) {
      const {error}=await db.rpc("leave_clan");
      if(error) alert(error.message); else await renderClans();
    }
  });

  $("communityContent").addEventListener("submit",async event=>{
    if (event.target.id==="createClanForm") {
      event.preventDefault();
      const fd=new FormData(event.target);
      const {error}=await db.rpc("create_clan",{p_name:String(fd.get("name")).trim(),p_description:String(fd.get("description")||"").trim()});
      if(error) alert(error.message); else await renderClans();
    }
    if (event.target.id==="inviteClanForm") {
      event.preventDefault();
      const username=String(new FormData(event.target).get("username")||"").trim().toLowerCase();
      const {data:player}=await db.from("profiles").select("id").eq("username",username).maybeSingle();
      if(!player) return alert("Player not found.");
      const {data:mine}=await db.from("clan_members").select("clan_id").eq("user_id",currentUser.id).maybeSingle();
      const {error}=await db.rpc("invite_clan_member",{p_clan_id:mine.clan_id,p_user_id:player.id});
      if(error) alert(error.message); else { alert("Invitation sent."); await renderClans(); }
    }
    if (event.target.id==="newGroupForm") {
      event.preventDefault();
      const fd=new FormData(event.target);
      const usernames=String(fd.get("usernames")).split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
      if (!usernames.length) return;
      const {data:players,error:lookupError}=await db.from("profiles").select("id,username").in("username",usernames);
      if(lookupError) return alert(lookupError.message);
      if(players.length!==usernames.length) return alert("One or more usernames were not found.");
      const {data,error}=await db.rpc("create_conversation",{p_member_ids:players.map(x=>x.id),p_title:String(fd.get("title")).trim()});
      if(error) alert(error.message); else { communityDialog.close(); await openChat(data,String(fd.get("title"))); }
    }
  });

  $("openMessages").addEventListener("click",()=>showCommunity("messages"));
  $("openClans").addEventListener("click",()=>showCommunity("clans"));
  $("openClanRanking").addEventListener("click",()=>showCommunity("ranking"));

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