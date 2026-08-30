/**
 * Vanity number viewer.
 *
 * Deliberately dependency-free and framework-free: one screen, one endpoint.
 * Everything is rendered with DOM APIs rather than innerHTML string building,
 * so API data can never be interpreted as markup. That matters more than usual
 * here because the values shown originate from a phone call, i.e. from outside.
 */
(function () {
  "use strict";

  /** Same-origin: CloudFront routes /api/* to the read Lambda. */
  var API_URL = "/api/recent?limit=5";
  var REFRESH_MS = 15000;
  /** How many of the stored numbers the IVR actually reads out. */
  var SPOKEN_COUNT = 3;

  var el = {
    calls: document.getElementById("calls"),
    empty: document.getElementById("empty"),
    error: document.getElementById("error"),
    errorDetail: document.getElementById("error-detail"),
    skeleton: document.getElementById("skeleton"),
    statusText: document.getElementById("status-text"),
    pulse: document.getElementById("pulse"),
    lastUpdated: document.getElementById("last-updated"),
    retry: document.getElementById("retry"),
  };

  var timer = null;
  var firstLoadDone = false;

  function show(node, visible) {
    node.hidden = !visible;
  }

  function setStatus(state, text) {
    el.pulse.dataset.state = state;
    el.statusText.textContent = text;
  }

  /**
   * "2026-08-30T10:22:31Z" -> "2 min ago". Falls back to the raw timestamp for
   * anything older than a day, because "37 hours ago" helps nobody.
   */
  function relativeTime(iso) {
    var then = Date.parse(iso);
    if (isNaN(then)) return iso;
    var seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 10) return "just now";
    if (seconds < 60) return seconds + " sec ago";
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    return new Date(then).toLocaleString();
  }

  /** Render "1-888-HELP-NOW" with the letter runs highlighted. */
  function renderVanityNumber(vanity) {
    var wrapper = document.createElement("span");
    wrapper.className = "vanity-number";
    var tokens = String(vanity).split("-");
    tokens.forEach(function (token, i) {
      if (i > 0) wrapper.appendChild(document.createTextNode("-"));
      var span = document.createElement("span");
      if (/^[A-Za-z]+$/.test(token)) span.className = "letters";
      span.textContent = token;
      wrapper.appendChild(span);
    });
    return wrapper;
  }

  function renderVanityRow(entry, index) {
    var li = document.createElement("li");
    li.className = "vanity";

    var rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1);
    li.appendChild(rank);

    var number = renderVanityNumber(entry.vanity);
    if (index < SPOKEN_COUNT) {
      var badge = document.createElement("span");
      badge.className = "spoken-badge";
      badge.textContent = "spoken";
      badge.title = "This option was read aloud to the caller.";
      number.appendChild(badge);
    }
    li.appendChild(number);

    var score = document.createElement("span");
    score.className = "score";
    var bar = document.createElement("span");
    bar.className = "score-bar";
    var fill = document.createElement("span");
    fill.className = "score-fill";
    var pct = Math.max(0, Math.min(100, Number(entry.score) || 0));
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    score.appendChild(bar);
    var label = document.createElement("span");
    label.textContent = pct.toFixed(1);
    label.title = "Memorability score out of 100";
    score.appendChild(label);
    li.appendChild(score);

    return li;
  }

  function renderCall(call) {
    var li = document.createElement("li");
    li.className = "call";

    var head = document.createElement("div");
    head.className = "call-head";

    var caller = document.createElement("span");
    caller.className = "caller";
    caller.textContent = call.callerNumber;
    head.appendChild(caller);

    var when = document.createElement("time");
    when.className = "called-at";
    when.dateTime = call.requestedAt;
    when.textContent = relativeTime(call.requestedAt);
    when.title = new Date(call.requestedAt).toLocaleString();
    head.appendChild(when);

    li.appendChild(head);

    var list = document.createElement("ul");
    list.className = "vanity-list";
    (call.vanityNumbers || []).forEach(function (entry, i) {
      list.appendChild(renderVanityRow(entry, i));
    });
    li.appendChild(list);

    return li;
  }

  function render(payload) {
    var calls = (payload && payload.calls) || [];

    // Rebuild rather than diff: five cards is far below the point where a
    // reconciliation strategy would pay for itself.
    el.calls.textContent = "";
    calls.forEach(function (call) {
      el.calls.appendChild(renderCall(call));
    });

    show(el.skeleton, false);
    show(el.error, false);
    show(el.calls, calls.length > 0);
    show(el.empty, calls.length === 0);

    el.lastUpdated.textContent = "updated " + new Date().toLocaleTimeString();
    setStatus("ok", calls.length + (calls.length === 1 ? " caller" : " callers"));
  }

  function renderError(message) {
    show(el.skeleton, false);
    // Keep whatever was last successfully rendered on screen; an intermittent
    // failure should not blank the page a viewer is reading.
    if (!firstLoadDone) {
      show(el.calls, false);
      show(el.empty, false);
    }
    el.errorDetail.textContent = message;
    show(el.error, true);
    setStatus("error", "offline");
  }

  function load() {
    setStatus("loading", firstLoadDone ? "refreshing" : "loading");

    // Abort a hung request rather than stacking them up behind a dead network.
    var controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, 8000);

    fetch(API_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("The server returned HTTP " + response.status + ".");
        }
        return response.json();
      })
      .then(function (payload) {
        firstLoadDone = true;
        render(payload);
      })
      .catch(function (err) {
        renderError(
          err && err.name === "AbortError"
            ? "The request timed out. The API may still be warming up."
            : (err && err.message) || "Unknown error.",
        );
      })
      .finally(function () {
        clearTimeout(timeout);
      });
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(load, REFRESH_MS);
  }

  function stopPolling() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Stop polling while the tab is hidden. On a page that refreshes forever this
  // is the difference between a demo and a background battery drain.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopPolling();
    } else {
      load();
      startPolling();
    }
  });

  el.retry.addEventListener("click", load);

  load();
  startPolling();
})();
