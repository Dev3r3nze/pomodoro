/**
   * Pomodoro app skeleton: UI + logic prepared for all requested features.
   * - Persistencia en localStorage (tasks + session state)
   * - Temporizador que actualiza document.title y sigue siendo válido si la pestaña pierde foco
   * - Barra de progreso, pausa/reanudar, iniciar/terminar sesión
   * - Cálculo de duración total estimada basado en tareas (estimación en tramos)
   *
   * Notas: ajusta duraciones y texto si quieres; la UI está pensada para extenderla.
   */

// === Config (puedes exponer estos valores en UI si quieres) ===
const FOCUS_SEC = 25 * 60;   // 25 minutos
const SHORT_BREAK_SEC = 5 * 60; // 5 minutos
const LONG_BREAK_SEC = 15 * 60; // 15 minutos
const LONG_BREAK_EVERY = 4; // cada 4 tramos concentración -> descanso largo

// Storage keys
const KEY_TASKS = 'pomodoro.tasks.v1';
const KEY_SESSION = 'pomodoro.session.v1';

// DOM
const tasksListEl = document.getElementById('tasks-list');
const totalPomosEl = document.getElementById('total-pomos');
const totalDurationEl = document.getElementById('total-duration');
const displayTimerEl = document.getElementById('display-timer');
const displayModeEl = document.getElementById('display-mode');
const startBtn = document.getElementById('start-session');
const pauseResumeBtn = document.getElementById('pause-resume');
const endBtn = document.getElementById('end-session');
const completedCountEl = document.getElementById('completed-count');
const progressBarEl = document.getElementById('progress-bar');
const progressRemainingEl = document.getElementById('progress-remaining');
const progressLabelEl = document.getElementById('progress-label');
const sessionStateEl = document.getElementById('session-state');
const sessionTotalDurationEl = document.getElementById('session-total-duration');
const sessionCompletedDisplayEl = document.getElementById('session-completed-display');
const currentTramoIndexEl = document.getElementById('current-tramo-index');

// Modal
const summaryModal = new bootstrap.Modal(document.getElementById('summaryModal'));

// State (in-memory, mirrored to storage)
let tasks = loadTasks();
let session = loadSession(); // may be null or object
let tickInterval = null;

// BroadcastChannel to sync across tabs (optional, fallback to storage events)
let bc;
try { bc = new BroadcastChannel('pomodoro_channel_v1'); bc.onmessage = onBroadcast; } catch (e) { bc = null; }

// Initialize
renderTasks();
updateEstimates();
restoreUIFromSession();

// --- Task management ---
document.getElementById('add-task-form').addEventListener('submit', e => {
    e.preventDefault();
    const title = document.getElementById('task-title').value.trim();
    const estimate = Math.max(1, parseInt(document.getElementById('task-estimate').value || '1', 10));
    if (!title) return;
    tasks.push({ id: cryptoRandomId(), title, estimate, done: false });
    saveTasks();
    renderTasks();
    updateEstimates();
    e.target.reset();
    document.getElementById('task-estimate').value = 1;
});

function renderTasks() {
    tasksListEl.innerHTML = '';
    if (tasks.length === 0) {
        tasksListEl.innerHTML = `<div class="text-muted small">No hay tareas. Añade una para empezar.</div>`;
        return;
    }
    tasks.forEach(t => {
    const li = document.createElement('div');
    li.className = 'task-row list-group-item d-flex justify-content-between align-items-center';
    if (t.done) li.classList.add('done');

    li.innerHTML = `
        <div class="d-flex w-75 align-items-center gap-3 user-select-none">
        <input type="checkbox" class="form-check-input mt-0 task-done" id="task-checkbox-${t.id}" data-id="${t.id}" ${t.done ? 'checked' : ''}>
        <div>
            <div class="fw-semibold"><label class="hover-pointer" for="task-checkbox-${t.id}">${escapeHtml(t.title)}</label></div>
            <div class="tiny text-muted"><label class="hover-pointer" for="task-checkbox-${t.id}">Estimación:</label> <strong>${t.estimate}</strong> tramos</div>
        </div>
        </div>
        <div class="d-flex gap-2 align-items-center">
        <input type="number" min="1" class="form-control form-control-sm task-est" data-id="${t.id}" value="${t.estimate}" style="width:84px;">
        <button class="btn btn-link btn-sm text-danger task-delete" data-id="${t.id}" title="Eliminar"><i class="bi bi-trash"></i></button>
        </div>
    `;
    tasksListEl.appendChild(li);
});

    // events
    tasksListEl.querySelectorAll('.task-done').forEach(chk => {
        chk.addEventListener('change', (e) => {
            const id = e.target.dataset.id;
            const t = tasks.find(x => x.id === id);
            t.done = e.target.checked;
            saveTasks();
            renderTasks();
        });
    });
    tasksListEl.querySelectorAll('.task-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.closest('[data-id]').dataset.id;
            tasks = tasks.filter(x => x.id !== id);
            saveTasks();
            renderTasks();
            updateEstimates();
        });
    });
    tasksListEl.querySelectorAll('.task-est').forEach(input => {
        input.addEventListener('change', (e) => {
            const id = e.target.dataset.id;
            const val = Math.max(1, parseInt(e.target.value || '1', 10));
            const t = tasks.find(x => x.id === id);
            t.estimate = val;
            saveTasks();
            updateEstimates();
        });
    });
}

function updateEstimates() {
    const total = tasks.reduce((s, t) => s + (t.estimate || 0), 0);
    totalPomosEl.textContent = total;
    // compute estimated duration (approx): sum of focus + breaks between them (short or long)
    let secs = 0;
    for (let i = 0; i < total; i++) {
        secs += FOCUS_SEC;
        // add break after each focus except last
        if (i < total - 1) {
            // if (i+1) divisible by LONG_BREAK_EVERY -> long break
            if ((i + 1) % LONG_BREAK_EVERY === 0) secs += LONG_BREAK_SEC;
            else secs += SHORT_BREAK_SEC;
        }
    }
    totalDurationEl.textContent = formatMinutes(secs);
    sessionTotalDurationEl.textContent = formatMinutesShort(secs);
}

// --- Session control ---
startBtn.addEventListener('click', startSession);
pauseResumeBtn.addEventListener('click', togglePauseResume);
endBtn.addEventListener('click', endSession);

function startSession() {
    // build session model from tasks: queue of focus tramos equal to sum of estimates
    const totalTramos = tasks.reduce((s, t) => s + (t.estimate || 0), 0);
    if (totalTramos === 0) {
        alert('Añade al menos un tramo estimado en las tareas para iniciar la sesión.');
        return;
    }

    // create a queue of "focus" tramos; we don't tie each focus to a specific task here, but you could.
    const now = Date.now();
    session = {
        startedAt: now,
        paused: false,
        pausedAt: null,
        mode: 'focus', // 'focus' | 'shortBreak' | 'longBreak'
        tramoIndex: 0, // cuantos tramos de concentración completados
        totalTramos: totalTramos,
        completedTramos: 0,
        // timer: we use endTimestamp for the current interval
        currentIntervalSeconds: FOCUS_SEC,
        endTimestamp: now + FOCUS_SEC * 1000,
        createdFromTasksSnapshot: tasks.map(t => ({ id: t.id, title: t.title, estimate: t.estimate, done: t.done })),
        history: [] // registro simple de tramos completados
    };

    saveSession();
    broadcast();
    startTick();
    updateUIFromSession();
}

function togglePauseResume() {
    if (!session) return;
    if (!session.paused) {
        // pause
        session.paused = true;
        session.pausedAt = Date.now();
        // compute remaining seconds
        session.remainingSeconds = Math.max(0, Math.round((session.endTimestamp - Date.now()) / 1000));
        saveSession();
        stopTick();
    } else {
        // resume
        session.paused = false;
        session.endTimestamp = Date.now() + (session.remainingSeconds * 1000);
        session.pausedAt = null;
        delete session.remainingSeconds;
        saveSession();
        startTick();
    }
    broadcast();
    updateUIFromSession();
}

function endSession() {
    if (!session) return;
    // compute elapsed
    const elapsedMs = Date.now() - session.startedAt;
    openSummaryModal(elapsedMs, session.completedTramos, session);
    // clear session
    session = null;
    localStorage.removeItem(KEY_SESSION);
    broadcast();
    stopTick();
    updateUIFromSession();
}

function completeCurrentInterval() {
    if (!session) return;
    const now = Date.now();
    // record
    const rec = { mode: session.mode, at: now, tramoIndex: session.tramoIndex + 1 };
    session.history.push(rec);

    if (session.mode === 'focus') {
        session.completedTramos += 1;
        session.tramoIndex += 1;
        // after a focus, decide break or end
        if (session.completedTramos >= session.totalTramos) {
            // session ends automatically
            // show summary
            const elapsedMs = Date.now() - session.startedAt;
            openSummaryModal(elapsedMs, session.completedTramos, session);
            session = null;
            localStorage.removeItem(KEY_SESSION);
            stopTick();
            broadcast();
            updateUIFromSession();
            return;
        } else {
            // schedule break
            if (session.completedTramos % LONG_BREAK_EVERY === 0) {
                session.mode = 'longBreak';
                session.currentIntervalSeconds = LONG_BREAK_SEC;
            } else {
                session.mode = 'shortBreak';
                session.currentIntervalSeconds = SHORT_BREAK_SEC;
            }
        }
    } else {
        // finished a break -> next focus
        session.mode = 'focus';
        session.currentIntervalSeconds = FOCUS_SEC;
    }

    // set next endTimestamp
    session.endTimestamp = Date.now() + session.currentIntervalSeconds * 1000;
    saveSession();
    broadcast();
    updateUIFromSession();
}

// --- Timer tick ---
function startTick() {
    stopTick();
    tick(); // immediate update
    tickInterval = setInterval(tick, 250); // updates UI & document.title
    pauseResumeBtn.disabled = false;
    endBtn.disabled = false;
    startBtn.disabled = true;
}
function stopTick() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    pauseResumeBtn.disabled = true;
    endBtn.disabled = true;
    startBtn.disabled = false;
}

function tick() {
    if (!session) {
        // restore idle UI
        displayTimerEl.textContent = secsToMMSS(FOCUS_SEC);
        displayModeEl.textContent = 'Listo';
        document.title = 'Pomodoro · Listo';
        updateUIFromSession();
        return;
    }
    if (session.paused) {
        displayModeEl.textContent = 'Pausado';
        // show remainingSeconds
        const rem = session.remainingSeconds ?? Math.max(0, Math.round((session.endTimestamp - Date.now()) / 1000));
        displayTimerEl.textContent = secsToMMSS(rem);
        document.title = `Pausado · ${displayTimerEl.textContent}`;
        progressBarEl.style.width = `${Math.round(((session.currentIntervalSeconds - rem) / session.currentIntervalSeconds) * 100)}%`;
        progressRemainingEl.textContent = displayTimerEl.textContent;
        return;
    }

    // compute remaining using endTimestamp (robust to tab switching)
    const remainingMs = session.endTimestamp - Date.now();
    let remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
    displayTimerEl.textContent = secsToMMSS(remainingSec);
    displayModeEl.textContent = session.mode === 'focus' ? 'Concentración' : (session.mode === 'shortBreak' ? 'Descanso corto' : 'Descanso largo');
    // update progress
    const doneSec = session.currentIntervalSeconds - remainingSec;
    const pct = Math.max(0, Math.min(100, Math.round((doneSec / session.currentIntervalSeconds) * 100)));
    progressBarEl.style.width = pct + '%';
    progressRemainingEl.textContent = displayTimerEl.textContent;
    // update title
    document.title = `${displayTimerEl.textContent} · ${displayModeEl.textContent}`;

    // if finished
    if (remainingSec <= 0) {
        // small delay to ensure tick shows 00:00 briefly
        completeCurrentInterval();
    }
}

// --- UI helpers ---
function updateUIFromSession() {
    if (!session) {
        sessionStateEl.textContent = 'Inactiva';
        sessionStateEl.className = 'meta-pill';
        pauseResumeBtn.disabled = true;
        endBtn.disabled = true;
        startBtn.disabled = false;
        completedCountEl.textContent = '0';
        sessionCompletedDisplayEl.textContent = '0';
        currentTramoIndexEl.textContent = '—';
        progressBarEl.style.width = '0%';
        progressRemainingEl.textContent = secsToMMSS(FOCUS_SEC);
        return;
    }
    sessionStateEl.textContent = 'En curso';
    sessionStateEl.className = 'meta-pill';
    completedCountEl.textContent = String(session.completedTramos || 0);
    sessionCompletedDisplayEl.textContent = String(session.completedTramos || 0);
    currentTramoIndexEl.textContent = `${Math.min(session.tramoIndex + 1, session.totalTramos)} / ${session.totalTramos}`;
    startBtn.disabled = true;
    endBtn.disabled = false;
    pauseResumeBtn.disabled = false;
    pauseResumeBtn.innerHTML = session.paused ? '<i class="bi bi-play-fill me-2"></i> Reanudar' : '<i class="bi bi-pause-fill me-2"></i> Pausar';
    // display current mode & remaining handled in tick()
}

function restoreUIFromSession() {
    if (!session) {
        updateUIFromSession();
        return;
    }
    // If session exists and not paused, we must ensure endTimestamp is still valid (in case of reload)
    if (!session.paused && session.endTimestamp && Date.now() > session.endTimestamp) {
        // finish the interval immediately
        completeCurrentInterval();
    }
    if (!tickInterval && session && !session.paused) startTick();
    updateUIFromSession();
    tick();
}

// --- Persistence ---
function loadTasks() {
    try {
        const raw = localStorage.getItem(KEY_TASKS);
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}
function saveTasks() {
    localStorage.setItem(KEY_TASKS, JSON.stringify(tasks));
    broadcast();
}
function loadSession() {
    try {
        const raw = localStorage.getItem(KEY_SESSION);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
function saveSession() {
    localStorage.setItem(KEY_SESSION, JSON.stringify(session));
    broadcast();
}

// Broadcast helper
function broadcast() {
    if (bc) try { bc.postMessage({ type: 'sync' }); } catch (e) { }
}
function onBroadcast(ev) {
    // When other tab changes storage, reload state
    const s = loadSession();
    if (!s && session) {
        // session was cleared elsewhere
        session = null;
        stopTick();
        updateUIFromSession();
        renderTasks(); // in case tasks changed
        updateEstimates();
        return;
    }
    tasks = loadTasks();
    renderTasks();
    updateEstimates();
    session = s;
    restoreUIFromSession();
}

// listen storage events (fallback)
window.addEventListener('storage', (e) => {
    if (e.key === KEY_TASKS || e.key === KEY_SESSION) {
        tasks = loadTasks();
        renderTasks();
        updateEstimates();
        session = loadSession();
        restoreUIFromSession();
    }
});

// page visibility: when shown, force tick to sync
document.addEventListener('visibilitychange', () => {
    // tick will compute based on endTimestamp so it's fine; force an immediate tick
    tick();
});

// --- Summary modal & end flow ---
function openSummaryModal(elapsedMs, completedPomos, sessionObj) {
    document.getElementById('summary-duration').textContent = msToFancyTime(elapsedMs);
    document.getElementById('summary-pomos').textContent = String(completedPomos);
    const ul = document.getElementById('summary-tasks');
    ul.innerHTML = '';
    // Show which tasks were completed at the moment (based on createdFromTasksSnapshot)
    const snapshot = sessionObj?.createdFromTasksSnapshot ?? tasks;
    snapshot.forEach(t => {
        const li = document.createElement('li');
        li.className = 'list-group-item';
        li.textContent = `${t.title} — estimados: ${t.estimate}${t.done ? ' — (marcada hecha)' : ''}`;
        ul.appendChild(li);
    });
    summaryModal.show();
}

// --- Utilities ---
function secsToMMSS(s) {
    s = Math.max(0, Math.floor(s));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function msToFancyTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (!h && !m) parts.push(`${secs}s`);
    return parts.join(' ');
}
function formatMinutes(totalSecs) {
    const mins = Math.round(totalSecs / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}
function formatMinutesShort(totalSecs) {
    const mins = Math.round(totalSecs / 60);
    return `${mins}m`;
}
function escapeHtml(s) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function cryptoRandomId() { return 'id-' + Math.random().toString(36).slice(2, 9); }

// keyboard: space toggle pause if session running
window.addEventListener('keydown', e => {
    if (e.code === 'Space' && session) {
        e.preventDefault();
        togglePauseResume();
    }
});

// initial document title
document.title = 'Pomodoro · Listo';

// init
restoreUIFromSession();