// The first reads start here, while the app's code is still downloading; the app takes them over once, by scope and path.
// The account read has a deadline. The recorded example's address names its scope; another repository's address is asked
// of the server, and its screen's reads start the moment it answers.
(function () {
  var reads = {};
  function start(path, scope, signal) {
    var headers = { accept: 'application/json' };
    if (scope) headers['x-braid-workspace'] = scope;
    var response = fetch(path, { headers: headers, cache: 'no-store', credentials: 'same-origin', signal: signal });
    response.catch(function () {});
    return response;
  }
  // A read the app finds under its scope and path.
  function read(path, scope) {
    var response = start(path, scope);
    reads[(scope || '') + ' ' + path] = response;
    return response;
  }
  var controller = new AbortController();
  var timer;
  var account = Promise.race([
    start('/api/account', null, controller.signal).then(function (response) {
      // Include the body in the deadline. The untouched response is buffered for the app to consume.
      return response.clone().arrayBuffer().then(function () { return response; });
    }),
    new Promise(function (_, reject) {
      timer = setTimeout(function () {
        controller.abort();
        reject(new Error('Account request timed out.'));
      }, 4000);
    }),
  ]).finally(function () { clearTimeout(timer); });
  account.catch(function () {});
  window.__braidEarly = { account: account, reads: reads };

  // The build names each route's chunks and the words no owner may take. This runs before the shell, without evaluating any screen.
  var metadata = document.querySelector('meta[name="braid-preloads"]');
  var assets = null;
  if (metadata) { try { assets = JSON.parse(metadata.content); } catch (_) { assets = null; } }
  var seen = new Set();
  function preload(files) {
    (files || []).forEach(function (href) {
      if (seen.has(href)) return;
      seen.add(href);
      var link = document.createElement('link');
      link.href = href;
      link.crossOrigin = '';
      // Warm CSS bytes only. Vite must insert and await the stylesheet itself:
      // its import helper treats an existing stylesheet link as already loaded. A font is only fetched, too.
      var as = href.endsWith('.css') ? 'style' : href.endsWith('.woff2') ? 'font' : null;
      link.rel = as ? 'preload' : 'modulepreload';
      if (as) link.as = as;
      document.head.appendChild(link);
    });
  }
  function extensionOf(name) { return name.split('/').pop().split('.').pop().toLowerCase(); }

  var path = location.pathname.replace(/\/+$/, '') || '/';
  var address = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  var under = address ? (address[3] || '').replace(/^\//, '') : '';
  // What a repository's screen reads first: its snapshot; on Code the listing and latest merge, or the file at a path.
  // The README is read once the listing names it, so its file name is never guessed.
  function repositoryReads(scope) {
    read('/api/state', scope);
    var pull = /^pull\/([a-zA-Z0-9_-]+)(?:\/(?:checks|files))?$/.exec(under);
    if (pull) {
      read('/api/changes/' + pull[1], scope);
      if (/\/files$/.test(under) && !new URLSearchParams(location.search).has('since')) {
        read('/api/changes/' + pull[1] + '/diff?path=' + encodeURIComponent(new URLSearchParams(location.search).get('file') || ''), scope);
      }
      read('/api/policy', scope);
      return;
    }
    if (under === 'agents') { read('/api/agents', scope); return; }
    if (under === 'queue') {
      read('/api/queue', scope);
      read('/api/changes?status=queued%2Clanding&limit=50', scope);
      read('/api/policy', scope);
      return;
    }
    // A named history ref and path are already known; the bare history route needs the snapshot's default branch.
    var history = /^commits\/([^/]+)(?:\/(.*))?$/.exec(under);
    if (history) {
      var branch, historyPath;
      try { branch = decodeURIComponent(history[1]); historyPath = decodeURIComponent(history[2] || ''); } catch (_) { return; }
      var cursor = new URLSearchParams(location.search).getAll('cursor').pop();
      read('/api/repository/commits?ref=' + encodeURIComponent(branch) + '&path=' + encodeURIComponent(historyPath) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), scope);
      return;
    }
    // Both refs share one segment. The comparison names the merge base, and the first diffs are read from it as soon as it answers.
    var compare = /^compare\/([^/]+)$/.exec(under);
    if (compare) {
      read('/api/changes?status=active&limit=100', scope);
      var refs;
      try { refs = decodeURIComponent(compare[1]).split('...'); } catch (_) { return; }
      if (!refs[0] || !refs[1]) return;
      read('/api/repository/compare?base=' + encodeURIComponent(refs[0]) + '&head=' + encodeURIComponent(refs[1]), scope)
        .then(function (response) { return response.ok ? response.clone().json() : null; })
        .then(function (comparison) {
          if (!comparison || comparison.status !== 'ready' || !comparison.mergeBase) return;
          // As many files as CompareScreen draws before they scroll into view (EAGER_FILES there).
          comparison.files.slice(0, 3).forEach(function (changed) {
            read('/api/repository/compare/diff?base=' + encodeURIComponent(comparison.mergeBase) + '&head=' + encodeURIComponent(comparison.head) + '&path=' + encodeURIComponent(changed.path), scope);
            if (assets) preload(assets.grammars[extensionOf(changed.path)]);
          });
        })
        .catch(function () {});
      return;
    }
    if (under === 'pulls') {
      read('/api/queue', scope);
      // The example's initial public list; member-only filters wait for account authorization.
      var query = new URLSearchParams(location.search);
      if (scope === 'demo' && !query.has('agent')) {
        var states = query.get('state') === 'closed' ? 'landed,closed' : 'open,revise,attention,queued,landing';
        read('/api/changes?status=' + encodeURIComponent(states) + '&limit=25', scope);
      }
      return;
    }
    if (!under) {
      read('/api/repository/tree?ref=&path=', scope);
      read('/api/changes?status=landed&limit=1', scope);
      return;
    }
    // A commit named in the address is read at that commit once the app knows it; a branch reads at the default head.
    var file = /^(tree|blob|blame)\/([^/]+)\/(.+)$/.exec(under);
    if (!file || /^[0-9a-f]{40}$/.test(file[2])) return;
    var name;
    try { name = decodeURIComponent(file[3]); } catch (_) { return; }
    read('/api/repository/tree?ref=&path=', scope);
    if (file[1] === 'tree') read('/api/repository/tree?ref=&path=' + encodeURIComponent(name), scope);
    else {
      read('/api/repository?ref=&path=' + encodeURIComponent(name), scope);
      if (file[1] === 'blame') read('/api/blame?path=' + encodeURIComponent(name) + '&ref=', scope);
    }
  }
  var slug = /^[a-z0-9][a-z0-9-]{0,38}$/;
  if (address && address[1] === 'example') {
    if (address[2] === 'relay') repositoryReads('demo');
  } else if (address && assets && assets.reserved && assets.reserved.indexOf(address[1]) < 0 && slug.test(address[1]) && slug.test(address[2])) {
    var found = start('/api/repos/' + address[1] + '/' + address[2], null);
    reads[' /api/repos/' + address[1] + '/' + address[2]] = found.then(function (response) { return response.clone(); });
    found.then(function (response) { return response.json(); })
      .then(function (repository) { if (repository && typeof repository.workspaceId === 'string') repositoryReads(repository.workspaceId); })
      .catch(function () {});
  }

  if (path === '/explore') {
    var search = new URLSearchParams(location.search);
    var listing = new URLSearchParams({ limit: '30' });
    var q = (search.get('q') || '').trim();
    if (q) listing.set('q', q);
    listing.set('sort', search.get('sort') === 'name' ? 'name' : 'updated');
    read('/api/repos?' + listing, null);
  }
  // Code search across repositories: the screen asks with the query exactly as the address carries it.
  if (path === '/search') {
    var asked = new URLSearchParams(location.search).get('q') || '';
    if (asked.trim()) read('/api/search?' + new URLSearchParams({ q: asked }), null);
  }

  if (!assets) return; // Development uses Vite's module graph directly.
  if (path === '/') preload(assets.landing);
  else if (path === '/explore') preload(assets.explore);
  else if (path === '/search') { preload(assets.search); preload(assets.mono); }
  else if (/^(?:\/[^/]+\/[^/]+)?\/agents$/.test(path)) preload(assets.agents);
  else if (/^(?:\/[^/]+\/[^/]+)?\/pulls$/.test(path)) preload(assets.pulls);
  else if (/^(?:\/[^/]+\/[^/]+)?\/pull\/[^/]+(?:\/checks)?$/.test(path)) preload(assets.pull);
  else if (/^(?:\/[^/]+\/[^/]+)?\/compare\/[^/]+$/.test(path)) { preload(assets.compare); preload(assets.viewer); preload(assets.mono); }
  else if (/^\/[^/]+\/[^/]+$/.test(path)) { preload(assets.code); preload(assets.markdown); }
  var file = /^(?:\/[^/]+\/[^/]+)?\/(blob|blame)\/[^/]+\/(.+)$/.exec(path);
  var files = /^(?:\/[^/]+\/[^/]+)?\/pull\/[^/]+\/files$/.test(path);
  if (file || files) {
    preload(file ? assets.code : assets.pull);
    // Blame draws source lines itself. The syntax viewer, grammars and Markdown parser are unused here.
    if (file && file[1] === 'blame') { preload(assets.mono); return; }
    if (files) {
      preload(assets.files);
    }
    preload(assets.viewer);
    var filename = file ? file[2] : new URLSearchParams(location.search).get('file') || '';
    try { filename = decodeURIComponent(filename); } catch (_) { /* Invalid escapes do not prevent the screen loading. */ }
    var extension = extensionOf(filename);
    // Plain source can paint before its grammar; have the final typeface ready for those first rows.
    if (file && !/^(md|markdown|mdown)$/.test(extension)) preload(assets.mono);
    preload(assets.grammars[extension]);
    if (/^(md|markdown|mdown)$/.test(extension)) preload(assets.markdown);
  }
})();
