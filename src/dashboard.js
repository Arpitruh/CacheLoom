const form = document.getElementById('filters');
const keyInput = document.getElementById('key');
const queueInput = document.getElementById('queue');
const statusNode = document.getElementById('status');
const stats = document.getElementById('stats');
const jobsBody = document.getElementById('jobs');

async function command(apiKey, command, options = {}) {
  const response = await fetch('/v1/jobs', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ command, ...options }),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) {
    const messages = { UNAUTHORIZED: 'Invalid project API key.', JOB_QUEUE_NOT_CONFIGURED: 'The job queue requires PostgreSQL storage.', STORAGE_UNAVAILABLE: 'Storage is temporarily unavailable. Please retry.', PROJECT_RATE_LIMITED: 'Request limit reached. Try again in a minute.' };
    throw new Error(messages[data.error] || 'Request failed (' + response.status + ').');
  }
  return data.result;
}

function element(type, content, cls) {
  const node = document.createElement(type);
  if (cls) node.className = cls;
  node.textContent = String(content);
  return node;
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const apiKey = keyInput.value;
  const queue = queueInput.value.trim();
  if (!apiKey) return;
  const options = queue ? { queue } : {};
  statusNode.textContent = 'Loading…';
  statusNode.classList.remove('error');
  stats.replaceChildren();
  jobsBody.replaceChildren();
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const [metrics, recent] = await Promise.all([
      command(apiKey, 'METRICS', options),
      command(apiKey, 'LIST', { ...options, limit: 50 }),
    ]);
    const counts = new Map();
    for (const entry of metrics) counts.set(entry.status, (counts.get(entry.status) ?? 0) + entry.count);
    for (const state of ['pending','running','completed','dead','cancelled']) {
      const card = element('div', '', 'card');
      card.append(element('small',state), element('strong',counts.get(state) ?? 0));
      stats.append(card);
    }
    for (const item of recent) {
      const row = document.createElement('tr');
      for (const value of [item.id, item.queue, item.status,
        item.attempts + '/' + item.max_attempts, new Date(item.run_at).toLocaleString()]) {
        row.append(element('td',value));
      }
      jobsBody.append(row);
    }
    statusNode.textContent = 'Loaded ' + recent.length + ' recent jobs. Select Load dashboard to refresh.';
  } catch (error) {
    statusNode.textContent = error.message;
    statusNode.classList.add('error');
  } finally {
    button.disabled = false;
  }
});
document.getElementById('clear').addEventListener('click', () => {
  keyInput.value = '';
  queueInput.value = '';
  stats.replaceChildren();
  jobsBody.replaceChildren();
  statusNode.textContent = 'Key cleared. Nothing is saved to browser storage.';
});
