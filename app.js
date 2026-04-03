import { fetchLeagueData, fetchFantasyCalcRankings } from './api.js';
import { 
    saveProtections, loadProtections,
    saveDraftOrder, loadDraftOrder,
    saveDraftPicks, loadDraftPicks,
    saveDispersed, loadDispersed,
    resetAllData
} from './storage.js';
import { listenToFirebase } from './firebase.js';

const POSITION_LIMITS = {
    QB: 1, RB: 2, WR: 3, TE: 1, IDP: 2, K: 1, FLEX: 3, SUPERFLEX: 1
};

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DL", "DE", "LB", "DB"];
const ROSTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX", "K", "DL", "LB", "DB"];
const PICK_TIME_LIMIT = 43200; // 12 hours in seconds
const DRAFT_START_TIME = new Date('2026-04-10T23:00:00Z'); // April 10th, 7 PM Eastern (11 PM UTC)
const MAX_DRAFT_PICKS = 36; // Total picks in the draft (3 rounds x 12 picks)
const PROTECTIONS_LOCK_TIME = new Date('2026-04-02T15:59:00Z'); // April 2nd, 11:59 AM ET (3:59 PM UTC)

// Base max picks per team is 3; increases by 2 for each dispersed team
function getMaxPicksPerTeam() {
    return 3 + (state.dispersed.size * 2);
}

// Substring search: checks if search term appears consecutively in player name (case insensitive)
function fuzzyMatch(playerName, searchTerm) {
    if (!searchTerm) return true;
    return playerName.toLowerCase().includes(searchTerm.toLowerCase());
}

// Check if draft has started (either naturally or by admin)
function isDraftStarted() {
    return state.draftStartedByAdmin || new Date() >= DRAFT_START_TIME;
}

// Get time remaining until draft starts (returns object with days, hours, minutes, seconds)
function getCountdownToDraftStart() {
    const now = new Date();
    const diff = DRAFT_START_TIME - now;
    
    if (diff <= 0) {
        return { days: 0, hours: 0, minutes: 0, seconds: 0, started: true };
    }
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    return { days, hours, minutes, seconds, started: false };
}

// Check if draft is complete (has reached 36 total picks)
function isDraftComplete() {
    return state.currentPick >= MAX_DRAFT_PICKS;
}

// Update player table visibility based on search term without full re-render
function updatePlayerTableSearch(playerPool) {
    const rows = document.querySelectorAll('[data-player-id]');
    let visibleCount = 0;
    
    rows.forEach(row => {
        const playerName = row.textContent;
        const matches = fuzzyMatch(playerName, state.searchTerm);
        row.style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
    });
    
    // Show "no results" message if needed
    const tableBody = document.querySelector('tbody');
    if (tableBody && visibleCount === 0 && state.searchTerm) {
        let noResultsRow = document.getElementById('no-results-row');
        if (!noResultsRow) {
            noResultsRow = document.createElement('tr');
            noResultsRow.id = 'no-results-row';
            noResultsRow.innerHTML = `<td colspan="7" style="text-align: center; color: #94a3b8; padding: 2rem;">No players match "${state.searchTerm}"</td>`;
            tableBody.appendChild(noResultsRow);
        } else {
            noResultsRow.innerHTML = `<td colspan="7" style="text-align: center; color: #94a3b8; padding: 2rem;">No players match "${state.searchTerm}"</td>`;
        }
    } else if (visibleCount > 0) {
        const noResultsRow = document.getElementById('no-results-row');
        if (noResultsRow) noResultsRow.remove();
    }
}

// Get time remaining until protections lock
function getCountdownToProtectionsLock() {
    const now = new Date();
    const diff = PROTECTIONS_LOCK_TIME - now;
    
    if (diff <= 0) {
        return { days: 0, hours: 0, minutes: 0, seconds: 0, locked: true };
    }
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    return { days, hours, minutes, seconds, locked: false };
}

// Check if protections are locked (after April 1st 11:59 PM ET)
function areProtectionsLocked() {
    return new Date() >= PROTECTIONS_LOCK_TIME;
}

let state = {
    leagueData: null,
    rankings: {},
    currentView: 'protect',
    protections: {},
    draftOrder: [],
    draftPicks: [],
    dispersed: new Set(),
    currentPick: 0,
    timeRemaining: PICK_TIME_LIMIT,
    timerInterval: null,
    selectedPlayer: null,
    positionFilter: 'ALL',
    searchTerm: '',
    selectedOwner: null,
    selectedPlayers: [],
    ownerChoice: {},
    draftView: 'table',
    adminAuthenticated: false,
    rosterRefreshInterval: null
};

async function init() {
    showLoading();
    
    try {
        state.protections = await loadProtections();
        state.draftPicks = await loadDraftPicks();
        state.draftOrder = await loadDraftOrder();
        const dispersedArray = await loadDispersed();
        state.dispersed = new Set(dispersedArray);
        
        listenToFirebase('draft_picks', (picks) => {
            if (picks) {
                state.draftPicks = picks;
                state.currentPick = picks.length;
                if (state.currentView === 'draft' || state.currentView === 'league') {
                    renderView(state.currentView);
                }
            }
        });
        
        state.leagueData = await fetchLeagueData();
        state.rankings = await fetchFantasyCalcRankings();
        state.currentPick = state.draftPicks.length;
        
        // Start periodic roster refresh to detect trades
        startRosterRefresh();
        
        state.leagueData.rosters.forEach(r => {
            const ownerId = r.owner_id;
            if (state.dispersed.has(ownerId)) {
                state.ownerChoice[ownerId] = 'disperse';
            } else if (state.protections[ownerId]) {
                const prot = state.protections[ownerId];
                if (Array.isArray(prot) && prot.length > 0) {
                    state.ownerChoice[ownerId] = 'protect';
                } else if (prot.players && prot.players.length > 0) {
                    state.ownerChoice[ownerId] = 'protect';
                }
            }
        });
        
        setupNavigation();
        renderView(state.currentView);
    } catch (error) {
        console.error('Init error:', error);
        showError('Failed to load league data. Please refresh the page.');
    }
}

function showLoading() {
    document.getElementById('content').innerHTML = '<div class="loading">Loading league data...</div>';
}

function showError(message) {
    document.getElementById('content').innerHTML = `<div class="loading" style="color: #f87171;">${message}</div>`;
}

function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            state.currentView = view;
            renderView(view);
            
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    
    document.querySelector(`[data-view="${state.currentView}"]`).classList.add('active');
}

function renderView(view) {
    const content = document.getElementById('content');
    
    switch(view) {
        case 'protect':
            renderProtectView(content);
            break;
        case 'setup':
            renderSetupView(content);
            break;
        case 'league':
            renderLeagueView(content);
            break;
        case 'draft':
            renderDraftView(content);
            break;
    }
}

function calculatePositionCounts(playerIds) {
    const counts = {};
    Object.keys(POSITION_LIMITS).forEach(k => counts[k] = 0);
    
    // Sort players to fill positions in priority order
    const playerPositions = playerIds.map(pid => {
        const pos = state.leagueData.players[pid]?.position || '?';
        return { pid, pos };
    });
    
    playerPositions.forEach(({ pid, pos }) => {
        let assigned = false;
        
        // Try exact position match first
        if (pos === 'QB' && counts.QB < POSITION_LIMITS.QB) {
            counts.QB++;
            assigned = true;
        } else if (pos === 'RB' && counts.RB < POSITION_LIMITS.RB) {
            counts.RB++;
            assigned = true;
        } else if (pos === 'WR' && counts.WR < POSITION_LIMITS.WR) {
            counts.WR++;
            assigned = true;
        } else if (pos === 'TE' && counts.TE < POSITION_LIMITS.TE) {
            counts.TE++;
            assigned = true;
        } else if (pos === 'K' && counts.K < POSITION_LIMITS.K) {
            counts.K++;
            assigned = true;
        } else if ((pos === 'DL' || pos === 'LB' || pos === 'DB' || pos === 'DE') && counts.IDP < POSITION_LIMITS.IDP) {
            counts.IDP++;
            assigned = true;
        }
        
        // If not assigned, try FLEX
        if (!assigned && (pos === 'RB' || pos === 'WR' || pos === 'TE') && counts.FLEX < POSITION_LIMITS.FLEX) {
            counts.FLEX++;
            assigned = true;
        }
        
        // If still not assigned, try SUPERFLEX
        if (!assigned && (pos === 'QB' || pos === 'RB' || pos === 'WR' || pos === 'TE') && counts.SUPERFLEX < POSITION_LIMITS.SUPERFLEX) {
            counts.SUPERFLEX++;
            assigned = true;
        }
        
        // If still not assigned, count as overage on primary position
        if (!assigned) {
            if (pos === 'QB') counts.QB++;
            else if (pos === 'RB') counts.RB++;
            else if (pos === 'WR') counts.WR++;
            else if (pos === 'TE') counts.TE++;
            else if (pos === 'K') counts.K++;
            else if (pos === 'DL' || pos === 'LB' || pos === 'DB' || pos === 'DE') counts.IDP++;
        }
    });
    
    return counts;
}

function renderProtectView(container) {
    const owners = state.leagueData.rosters.map(r => ({
        id: r.owner_id,
        name: state.leagueData.ownerMap[r.owner_id],
        players: r.players || []
    }));
    
    const protectionsLocked = areProtectionsLocked();
    const lockCountdown = getCountdownToProtectionsLock();

    if (!state.selectedOwner) {
        container.innerHTML = `
            <div class="card">
                <h2 class="card-title"><span>🛡️</span> Select Owner</h2>
                ${protectionsLocked ? `
                    <div class="warning-box" style="margin-bottom: 1rem;">
                        <p>🔒 Protections are now locked and cannot be modified.</p>
                        <p style="margin-top: 0.5rem; font-size: 0.875rem;">Deadline was April 1st at 11:59 PM ET</p>
                    </div>
                ` : `
                    <div class="info-box" style="margin-bottom: 1rem;">
                        <p><strong>Time until lock:</strong> ${lockCountdown.days}d ${lockCountdown.hours}h ${lockCountdown.minutes}m ${lockCountdown.seconds}s</p>
                        <p style="margin-top: 0.5rem; font-size: 0.875rem;">Deadline: April 1st at 11:59 PM ET</p>
                    </div>
                `}
                <div class="input-group">
                    <select id="owner-select" ${protectionsLocked ? 'disabled' : ''}>
                        <option value="">Choose an owner...</option>
                        ${owners.map(o => `<option value="${o.id}">${o.name}</option>`).join('')}
                    </select>
                </div>
            </div>
        `;

        const ownerSelect = document.getElementById('owner-select');
        if (ownerSelect && !protectionsLocked) {
            ownerSelect.addEventListener('change', (e) => {
                state.selectedOwner = e.target.value;
                if (state.selectedOwner) {
                    const prot = state.protections[state.selectedOwner];
                    if (Array.isArray(prot)) {
                        state.selectedPlayers = [...prot];
                    } else if (prot && prot.players) {
                        state.selectedPlayers = [...prot.players];
                    } else {
                        state.selectedPlayers = [];
                    }
                    renderProtectView(container);
                }
            });
        }
        
        // Update countdown every second if not locked
        if (!protectionsLocked) {
            const countdownInterval = setInterval(() => {
                const countdown = getCountdownToProtectionsLock();
                if (countdown.locked) {
                    clearInterval(countdownInterval);
                    renderProtectView(container);
                } else {
                    const infoBoxes = document.querySelectorAll('.info-box');
                    infoBoxes.forEach(box => {
                        if (box.textContent.includes('Time until lock:')) {
                            box.innerHTML = `
                                <p><strong>Time until lock:</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s</p>
                                <p style="margin-top: 0.5rem; font-size: 0.875rem;">Deadline: April 1st at 11:59 PM ET</p>
                            `;
                        }
                    });
                }
            }, 1000);
        }
        return;
    }

    const owner = owners.find(o => o.id === state.selectedOwner);
    const ownerName = state.leagueData.ownerMap[state.selectedOwner];
    const choice = state.ownerChoice[state.selectedOwner] || null;
    
    const protectionData = state.protections[state.selectedOwner];
    const isLocked = protectionData && protectionData._locked;
    const savedPassword = protectionData ? protectionData._password : null;
    
    // Recalculate counts
    const counts = calculatePositionCounts(state.selectedPlayers);
    const hasOverages = Object.entries(counts).some(([pos, count]) => count > POSITION_LIMITS[pos]);

    const sortedPlayers = owner.players.map(pid => {
        const player = state.leagueData.players[pid] || {};
        const ranking = state.rankings[pid] || { overallRank: 9999, posRank: 999 };
        return {
            id: pid,
            name: player.full_name || pid,
            position: player.position || '?',
            team: player.team || 'FA',
            overallRank: ranking.overallRank,
            posRank: ranking.posRank
        };
    }).sort((a, b) => {
        const posA = POSITION_ORDER.indexOf(a.position);
        const posB = POSITION_ORDER.indexOf(b.position);
        if (posA !== -1 && posB !== -1) {
            if (posA !== posB) return posA - posB;
            return a.overallRank - b.overallRank;
        }
        if (posA === -1 && posB !== -1) return 1;
        if (posA !== -1 && posB === -1) return -1;
        return a.overallRank - b.overallRank;
    });

    const protectedPlayers = state.selectedPlayers.map(pid => {
        const player = state.leagueData.players[pid] || {};
        const ranking = state.rankings[pid] || { overallRank: 9999, posRank: 999 };
        return {
            id: pid,
            name: player.full_name || pid,
            position: player.position || '?',
            team: player.team || 'FA',
            overallRank: ranking.overallRank,
            posRank: ranking.posRank
        };
    });
    
    let statusHTML = '';
    if (protectionsLocked) {
        statusHTML = `
            <div class="warning-box">
                <p>🔒 Protections are locked. Changes can no longer be made.</p>
                <p style="margin-top: 0.5rem; font-size: 0.875rem;">Deadline was April 1st at 11:59 PM ET</p>
            </div>
        `;
    } else {
        statusHTML = `
            <div class="info-box">
                <p><strong>Time until lock:</strong> ${lockCountdown.days}d ${lockCountdown.hours}h ${lockCountdown.minutes}m ${lockCountdown.seconds}s</p>
                <p style="margin-top: 0.5rem; font-size: 0.875rem;">Deadline: April 1st at 11:59 PM ET</p>
            </div>
        `;
    }

    container.innerHTML = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h2 class="card-title"><span>🛡️</span> ${ownerName}</h2>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-danger" id="reset-password-btn">🔑 Reset Password</button>
                    <button class="btn btn-secondary" id="back-btn">← Back</button>
                </div>
            </div>
            ${statusHTML}
        </div>

        <div class="card">
            <h3 style="color: white; margin-bottom: 1rem;">Choose Option</h3>
            ${protectionsLocked ? `
                <div class="warning-box">
                    <p>🔒 Protections are locked. No changes can be made after the April 1st deadline.</p>
                </div>
            ` : isLocked ? `
                <div class="warning-box">
                    <p>🔒 Protections are locked. Enter password to unlock and make changes.</p>
                    <div class="input-group" style="margin-top: 1rem;">
                        <input type="password" id="unlock-password" placeholder="Enter password" style="max-width: 300px;">
                        <button class="btn btn-primary" id="unlock-btn" style="margin-top: 0.5rem;">Unlock</button>
                    </div>
                </div>
            ` : `
                <div class="toggle-option">
                    <input type="radio" id="protect-radio" name="owner-choice" value="protect" ${choice === 'protect' ? 'checked' : ''}>
                    <label for="protect-radio">
                        <strong style="color: white;">Protect Players</strong>
                        <div style="font-size: 0.875rem; color: #94a3b8; margin-top: 0.25rem;">
                            Select up to the position limits to keep on your roster
                        </div>
                    </label>
                </div>
                <div class="toggle-option">
                    <input type="radio" id="disperse-radio" name="owner-choice" value="disperse" ${choice === 'disperse' ? 'checked' : ''}>
                    <label for="disperse-radio">
                        <strong style="color: white;">Disperse Team</strong>
                        <div style="font-size: 0.875rem; color: #94a3b8; margin-top: 0.25rem;">
                            All players available in draft pool, and you'll join the draft order
                        </div>
                    </label>
                </div>
            `}
        </div>

        ${choice === 'protect' && !isLocked && !protectionsLocked ? `
            <div class="card">
                <h3 style="color: white; margin-bottom: 1rem;">Position Limits</h3>
                <div class="position-grid">
                    ${Object.entries(POSITION_LIMITS).map(([pos, limit]) => `
                        <div class="position-card ${counts[pos] > limit ? 'full' : counts[pos] === limit ? 'at-limit' : ''}">
                            <div class="position-label">${pos}</div>
                            <div class="position-count">${counts[pos]}/${limit}</div>
                        </div>
                    `).join('')}
                </div>
                ${hasOverages ? `
                    <div class="warning-box" style="margin-top: 1rem;">
                        <p>⚠️ You have exceeded position limits! Remove players before saving:</p>
                        <ul style="margin-top: 0.5rem; margin-left: 1.5rem;">
                            ${Object.entries(counts).filter(([pos, count]) => count > POSITION_LIMITS[pos])
                                .map(([pos, count]) => `<li>${pos}: ${count}/${POSITION_LIMITS[pos]} (${count - POSITION_LIMITS[pos]} over)</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
            </div>

            ${protectedPlayers.length > 0 ? `
                <div class="card">
                    <h3 style="color: white; margin-bottom: 1rem;">Protected Players</h3>
                    <div class="table-container" style="max-height: 300px;">
                        <table class="player-table">
                            <thead>
                                <tr>
                                    <th>Overall Rank</th>
                                    <th>Pos Rank</th>
                                    <th>Player</th>
                                    <th>Pos</th>
                                    <th>Team</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${protectedPlayers.map(p => `
                                    <tr>
                                        <td><span class="rank-badge">#${p.overallRank}</span></td>
                                        <td><span class="rank-badge">${p.position} ${p.posRank}</span></td>
                                        <td style="font-weight: 600;">${p.name}</td>
                                        <td>${p.position}</td>
                                        <td>${p.team}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : ''}

            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                    <h3 style="color: white;">Select Players to Protect</h3>
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-danger" id="reset-protections-btn">Reset Protections</button>
                        <button class="btn btn-primary" id="save-btn" ${hasOverages ? 'disabled' : ''}>Save & Lock Protections</button>
                    </div>
                </div>
                <div class="input-group" style="max-width: 300px;">
                    <label>Password (required to save and lock)</label>
                    <input type="password" id="password-input" placeholder="Enter password" ${hasOverages ? 'disabled' : ''}>
                </div>
                <div class="table-container" id="protect-table-container">
                    <table class="player-table">
                        <thead>
                            <tr>
                                <th>Overall Rank</th>
                                <th>Pos Rank</th>
                                <th>Player</th>
                                <th>Pos</th>
                                <th>Team</th>
                                <th>Protected</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sortedPlayers.map(p => {
                                const isSelected = state.selectedPlayers.includes(p.id);
                                return `
                                    <tr class="${isSelected ? 'selected' : ''}" data-player-id="${p.id}" style="cursor: pointer;">
                                        <td><span class="rank-badge">#${p.overallRank}</span></td>
                                        <td><span class="rank-badge">${p.position} ${p.posRank}</span></td>
                                        <td style="font-weight: 600;">${p.name}</td>
                                        <td>${p.position}</td>
                                        <td>${p.team}</td>
                                        <td>${isSelected ? '✓' : ''}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        ` : choice === 'disperse' && !isLocked && !protectionsLocked ? `
            <div class="info-box">
                <p>✓ Team marked as dispersed. All players are available in the draft pool.</p>
            </div>
            <div class="card">
                <button class="btn btn-primary" id="save-disperse-btn">Confirm Dispersal</button>
            </div>
        ` : ''}
    `;

    document.getElementById('back-btn').addEventListener('click', () => {
        state.selectedOwner = null;
        state.selectedPlayers = [];
        renderProtectView(container);
    });
    
    const resetPasswordBtn = document.getElementById('reset-password-btn');
    if (resetPasswordBtn) {
        resetPasswordBtn.addEventListener('click', () => {
            const adminPassword = prompt('Enter admin password to reset this team\'s protection password:');
            if (adminPassword === null) return; // User cancelled
            
            // Simple admin password check - you can customize this
            if (adminPassword === 'admin123') {
                if (confirm(`Reset password for ${ownerName}? This will require them to set a new password.`)) {
                    const protectionData = state.protections[state.selectedOwner];
                    if (protectionData) {
                        // Keep their protected players but clear the password
                        state.protections[state.selectedOwner] = {
                            players: Array.isArray(protectionData) ? protectionData : (protectionData.players || []),
                            _locked: false,
                            _password: null
                        };
                        saveProtections(state.protections);
                        alert(`Password reset for ${ownerName}! They can now set a new password.`);
                        renderProtectView(container);
                    } else {
                        alert('No protections found for this team.');
                    }
                }
            } else {
                alert('Incorrect admin password.');
            }
        });
    }
    
    document.getElementById('reset-password-btn').addEventListener('click', () => {
        const adminPassword = prompt('Enter admin password to reset this team\'s protection password:');
        if (adminPassword === null) return; // User cancelled
        
        // Simple admin password check - you can customize this
        if (adminPassword === 'admin123') {
            if (confirm(`Reset password for ${ownerName}? This will require them to set a new password.`)) {
                const protectionData = state.protections[state.selectedOwner];
                if (protectionData) {
                    // Keep their protected players but clear the password
                    state.protections[state.selectedOwner] = {
                        players: Array.isArray(protectionData) ? protectionData : (protectionData.players || []),
                        _locked: false,
                        _password: null
                    };
                    saveProtections(state.protections);
                    alert(`Password reset for ${ownerName}! They can now set a new password.`);
                    renderProtectView(container);
                } else {
                    alert('No protections found for this team.');
                }
            }
        } else {
            alert('Incorrect admin password.');
        }
    });
    
    // Update countdown every second if not locked
    if (!protectionsLocked) {
        const countdownInterval = setInterval(() => {
            const countdown = getCountdownToProtectionsLock();
            if (countdown.locked) {
                clearInterval(countdownInterval);
                renderProtectView(container);
            } else {
                const infoBoxes = document.querySelectorAll('.info-box');
                infoBoxes.forEach(box => {
                    if (box.textContent.includes('Time until lock:')) {
                        box.innerHTML = `
                            <p><strong>Time until lock:</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s</p>
                            <p style="margin-top: 0.5rem; font-size: 0.875rem;">Deadline: April 1st at 11:59 PM ET</p>
                        `;
                    }
                });
            }
        }, 1000);
    }

    if (isLocked && document.getElementById('unlock-btn')) {
        document.getElementById('unlock-btn').addEventListener('click', () => {
            const password = document.getElementById('unlock-password').value;
            if (password === savedPassword) {
                const currentProtections = state.protections[state.selectedOwner];
                if (Array.isArray(currentProtections)) {
                    state.selectedPlayers = [...currentProtections];
                } else {
                    state.selectedPlayers = [...(currentProtections.players || [])];
                }
                delete state.protections[state.selectedOwner];
                state.protections[state.selectedOwner] = [...state.selectedPlayers];
                saveProtections(state.protections);
                alert('Protections unlocked!');
                renderProtectView(container);
            } else {
                alert('Incorrect password!');
            }
        });
    }

    // Update countdown timer on the owner select screen
    if (!state.selectedOwner) return;

    const protectRadio = document.getElementById('protect-radio');
    const disperseRadio = document.getElementById('disperse-radio');
    
    if (protectRadio && disperseRadio) {
        protectRadio.addEventListener('change', () => {
            state.ownerChoice[state.selectedOwner] = 'protect';
            state.dispersed.delete(state.selectedOwner);
            const prot = state.protections[state.selectedOwner];
            if (Array.isArray(prot)) {
                state.selectedPlayers = [...prot];
            } else if (prot && prot.players) {
                state.selectedPlayers = [...prot.players];
            } else {
                state.selectedPlayers = [];
            }
            renderProtectView(container);
        });
        
        disperseRadio.addEventListener('change', () => {
            state.ownerChoice[state.selectedOwner] = 'disperse';
            renderProtectView(container);
        });
    }

    if (choice === 'protect') {
        const tableContainer = document.getElementById('protect-table-container');
        
        if (protectionsLocked) {
            // Disable all interactive elements when globally locked
            document.querySelectorAll('[data-player-id]').forEach(item => {
                item.style.cursor = 'not-allowed';
                item.style.opacity = '0.5';
            });
            return;
        }
        
        document.querySelectorAll('[data-player-id]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                
                const playerId = item.dataset.playerId;
                const scrollPos = tableContainer.scrollTop;
                
                if (state.selectedPlayers.includes(playerId)) {
                    state.selectedPlayers = state.selectedPlayers.filter(id => id !== playerId);
                } else {
                    state.selectedPlayers = [...state.selectedPlayers, playerId];
                }
                
                renderProtectView(container);
                
                setTimeout(() => {
                    const newTableContainer = document.getElementById('protect-table-container');
                    if (newTableContainer) {
                        newTableContainer.scrollTop = scrollPos;
                    }
                }, 10);
            });
        });

        document.getElementById('reset-protections-btn').addEventListener('click', () => {
            if (protectionsLocked) {
                alert('Protections are locked and cannot be modified.');
                return;
            }
            if (confirm('Reset all protections for this team? This will clear your selections.')) {
                state.selectedPlayers = [];
                delete state.protections[state.selectedOwner];
                saveProtections(state.protections);
                renderProtectView(container);
            }
        });

        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                if (protectionsLocked) {
                    alert('Protections are locked. The deadline to submit protections was April 1st at 11:59 PM ET.');
                    return;
                }
                
                const password = document.getElementById('password-input').value;
                
                if (!password) {
                    alert('Please enter a password to lock your protections.');
                    return;
                }
                
                const finalCounts = calculatePositionCounts(state.selectedPlayers);
                const errors = [];
                
                Object.entries(POSITION_LIMITS).forEach(([pos, limit]) => {
                    if (finalCounts[pos] > limit) {
                        errors.push(`${pos}: ${finalCounts[pos]}/${limit} (over limit)`);
                    }
                });
                
                if (errors.length > 0) {
                    alert('Position limits exceeded:\n' + errors.join('\n'));
                    return;
                }
                
                state.protections[state.selectedOwner] = {
                    players: [...state.selectedPlayers],
                    _password: password,
                    _locked: true
                };
                saveProtections(state.protections);
                alert('Protections saved and locked!');
                renderProtectView(container);
            });
        }
    }

    if (choice === 'disperse' && document.getElementById('save-disperse-btn')) {
        if (protectionsLocked) {
            document.getElementById('save-disperse-btn').disabled = true;
            return;
        }
        
        document.getElementById('save-disperse-btn').addEventListener('click', () => {
            state.dispersed.add(state.selectedOwner);
            state.protections[state.selectedOwner] = [];
            saveDispersed([...state.dispersed]);
            saveProtections(state.protections);
            alert('Team marked as dispersed!');
        });
    }
}

function renderSetupView(container) {
    const dispersedTeams = [];
    state.leagueData.rosters.forEach(r => {
        if (state.dispersed.has(r.owner_id)) {
            dispersedTeams.push(state.leagueData.ownerMap[r.owner_id]);
        }
    });

    container.innerHTML = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 class="card-title" style="margin-bottom: 0;"><span>👥</span> Draft Order</h2>
                <button class="btn btn-primary" id="randomize-btn">🎲 Randomize Order</button>
            </div>
            <p style="color: #94a3b8; margin-bottom: 1rem; font-size: 0.875rem;">
                Add expansion teams and any dispersed teams to the draft order. Snake draft will alternate picks.
            </p>
            <div id="draft-order-list">
                ${state.draftOrder.map((team, idx) => `
                    <div class="input-group" style="display: flex; gap: 0.5rem; align-items: center;">
                        <label style="min-width: 30px;">${idx + 1}.</label>
                        <input type="text" value="${team}" data-order-index="${idx}" style="flex: 1;">
                        <button class="btn btn-danger" data-remove-index="${idx}" style="padding: 0.5rem 1rem;">✕</button>
                    </div>
                `).join('')}
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                <button class="btn btn-primary" id="add-team-btn">+ Add Team</button>
            </div>
        </div>
        ${dispersedTeams.length > 0 ? `
            <div class="info-box">
                <p><strong>Dispersed Teams:</strong> ${dispersedTeams.join(', ')}</p>
                <p style="margin-top: 0.5rem; font-size: 0.875rem;">Add these teams to the draft order above.</p>
            </div>
        ` : ''}
    `;

    container.querySelectorAll('[data-order-index]').forEach(input => {
        input.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.orderIndex);
            state.draftOrder[idx] = e.target.value;
            saveDraftOrder(state.draftOrder);
        });
    });

    container.querySelectorAll('[data-remove-index]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.removeIndex);
            state.draftOrder.splice(idx, 1);
            saveDraftOrder(state.draftOrder);
            renderSetupView(container);
        });
    });

    document.getElementById('add-team-btn').addEventListener('click', () => {
        state.draftOrder.push('New Team');
        saveDraftOrder(state.draftOrder);
        renderSetupView(container);
    });

    document.getElementById('randomize-btn').addEventListener('click', () => {
        if (confirm('Randomize the draft order?')) {
            for (let i = state.draftOrder.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [state.draftOrder[i], state.draftOrder[j]] = [state.draftOrder[j], state.draftOrder[i]];
            }
            saveDraftOrder(state.draftOrder);
            renderSetupView(container);
        }
    });
}

function renderLeagueView(container) {
    const draftedPlayers = new Map();
    state.draftPicks.forEach(pick => {
        draftedPlayers.set(pick.playerId, {
            newTeam: pick.teamId,
            pickNumber: pick.pickNumber
        });
    });

    const formatPickNumber = (pickNum) => {
        const round = Math.floor((pickNum - 1) / state.draftOrder.length) + 1;
        const pick = ((pickNum - 1) % state.draftOrder.length) + 1;
        return `${round}.${pick.toString().padStart(2, '0')}`;
    };

    container.innerHTML = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 class="card-title"><span>🏈</span> League Rosters</h2>
            </div>
        </div>
        ${state.leagueData.rosters.map(roster => {
            const ownerId = roster.owner_id;
            const ownerName = state.leagueData.ownerMap[ownerId];
            const isDispersed = state.dispersed.has(ownerId);
            const protectionData = state.protections[ownerId];
            let protectedIds = [];
            
            if (Array.isArray(protectionData)) {
                protectedIds = protectionData;
            } else if (protectionData && protectionData.players) {
                protectedIds = protectionData.players;
            }

            const players = (roster.players || []).map(pid => {
                const player = state.leagueData.players[pid] || {};
                const ranking = state.rankings[pid] || { overallRank: 9999, posRank: 999 };
                const drafted = draftedPlayers.get(pid);
                const isProtected = protectedIds.includes(pid);

                return {
                    id: pid,
                    name: player.full_name || pid,
                    position: player.position || '?',
                    team: player.team || 'FA',
                    overallRank: ranking.overallRank,
                    isProtected,
                    drafted
                };
            }).sort((a, b) => {
                const posA = POSITION_ORDER.indexOf(a.position);
                const posB = POSITION_ORDER.indexOf(b.position);
                if (posA !== -1 && posB !== -1) {
                    if (posA !== posB) return posA - posB;
                    return a.overallRank - b.overallRank;
                }
                if (posA === -1 && posB !== -1) return 1;
                if (posA !== -1 && posB === -1) return -1;
                return a.overallRank - b.overallRank;
            });

            return `
                <div class="league-roster">
                    <div class="league-roster-header">
                        ${ownerName} ${isDispersed ? '(Dispersed)' : ''}
                    </div>
                    ${players.map(p => `
                        <div class="league-player-item ${p.isProtected ? 'protected' : ''} ${p.drafted ? 'drafted' : ''}">
                            <div>
                                <strong>${p.name}</strong>
                                <span style="color: #94a3b8; margin-left: 0.5rem;">${p.position} - ${p.team}</span>
                            </div>
                            <div style="text-align: right;">
                                ${p.isProtected ? '<span style="color: #93c5fd;">🛡️ Protected</span>' : ''}
                                ${p.drafted ? `<span style="color: #6ee7b7;">✓ ${p.drafted.newTeam} (${formatPickNumber(p.drafted.pickNumber)})</span>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }).join('')}
    `;
    

}

function renderDraftView(container) {
    const availablePlayers = getAvailablePlayers();
    const filtered = state.positionFilter === 'ALL' ? availablePlayers : availablePlayers.filter(p => p.position === state.positionFilter);
    const currentDrafter = getCurrentDrafter();
    
    if (state.draftView === 'roster') {
        renderRosterBoard(container, availablePlayers, currentDrafter);
    } else {
        renderTableView(container, filtered, currentDrafter);
    }
}

function renderTableView(container, filtered, currentDrafter) {
    const searchFiltered = filtered.filter(p => fuzzyMatch(p.name, state.searchTerm));
    const draftStarted = isDraftStarted();
    const draftComplete = isDraftComplete();
    const countdown = getCountdownToDraftStart();
    
    let statusHTML = '';
    let adminHTML = '';
    
    if (!state.adminAuthenticated) {
        adminHTML = `
            <div style="margin-bottom: 1rem;">
                <button class="btn btn-primary" id="admin-login-btn" style="font-size: 0.875rem; padding: 0.5rem 1rem;">🔐 Admin Login</button>
            </div>
        `;
    } else {
        adminHTML = `
            <div class="info-box" style="margin-bottom: 1rem;">
                <p>✓ Admin authenticated. You can now manage the draft.</p>
                <button class="btn btn-danger" id="admin-logout-btn" style="margin-top: 0.5rem; padding: 0.5rem 1rem; font-size: 0.875rem;">Logout</button>
            </div>
        `;
    }
    
    if (!draftStarted && !state.adminAuthenticated) {
        statusHTML = `
            <div class="warning-box" style="margin-bottom: 1rem;">
                <p><strong>Draft starts in:</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s</p>
                <p style="margin-top: 0.5rem; font-size: 0.875rem;">April 10th, 2026 at 7:00 PM ET</p>
            </div>
        `;
    } else if (!draftStarted && state.adminAuthenticated) {
        statusHTML = `
            <div class="warning-box" style="margin-bottom: 1rem;">
                <p><strong>Draft has not started yet.</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s remaining</p>
                <button class="btn btn-success" id="admin-start-draft-btn" style="margin-top: 0.5rem;">▶️ Start Draft Now (Admin)</button>
            </div>
        `;
    } else if (draftComplete) {
        statusHTML = `
            <div class="info-box" style="margin-bottom: 1rem;">
                <p>✓ Draft Complete! All 12 rounds finished.</p>
            </div>
        `;
    }
    
    container.innerHTML = `
        <div class="card">
            ${adminHTML}
            ${statusHTML}
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <div class="draft-header" style="margin-bottom: 0;">
                    <div class="draft-info">
                        <h2>Pick #${state.currentPick + 1} / ${MAX_DRAFT_PICKS}</h2>
                        <p>Now drafting: <strong style="color: white;">${currentDrafter}</strong></p>
                    </div>
                    <div class="draft-timer">
                        <div class="timer-display"><span>⏰</span>${formatTime(state.timeRemaining)}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-secondary" id="toggle-view-btn">📋 Roster View</button>
                    ${state.adminAuthenticated ? `<button class="btn btn-danger" id="admin-reset-draft-btn">🔄 Reset Draft (Admin)</button>` : ''}
                </div>
            </div>
            <div class="input-group" style="max-width: 400px; margin-bottom: 1rem;">
                <input type="text" id="player-search" placeholder="Search player by name..." value="${state.searchTerm}" style="padding: 0.75rem; font-size: 1rem;">
            </div>
            <div class="filter-buttons">
                ${['ALL', ...POSITION_ORDER].map(pos => `
                    <button class="filter-btn ${state.positionFilter === pos ? 'active' : ''}" data-filter="${pos}">${pos}</button>
                `).join('')}
            </div>
            <div class="table-container">
                <table class="player-table">
                    <thead>
                        <tr>
                            <th>FantasyCalc Overall Rank</th>
                            <th>FantasyCalc Pos Rank</th>
                            <th>Player</th>
                            <th>Pos</th>
                            <th>Team</th>
                            <th>Current Owner</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${searchFiltered.map(player => {
                            const canDraft = state.dispersed.has(player.originalOwnerId) || getTeamPicksCount(player.originalOwnerId) < getMaxPicksPerTeam();
                            const isSelected = state.selectedPlayer?.playerId === player.playerId;
                            return `
                                <tr class="${isSelected ? 'selected' : ''}" data-player-id="${player.playerId}" data-owner-id="${player.originalOwnerId}"
                                    style="cursor: ${!canDraft ? 'not-allowed' : 'pointer'}; opacity: ${!canDraft ? '0.5' : '1'}">
                                    <td><span class="rank-badge">#${player.overallRank}</span></td>
                                    <td><span class="rank-badge">${player.position} ${player.posRank}</span></td>
                                    <td style="font-weight: 600;">${player.name}</td>
                                    <td>${player.position}</td>
                                    <td>${player.team}</td>
                                    <td style="font-size: 0.875rem; color: #94a3b8;">${player.ownerName}</td>
                                    <td>${!canDraft ? '<span style="color: #f87171; font-size: 0.75rem;">Max</span>' : isSelected ? '✓' : ''}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            ${state.selectedPlayer ? `
                <button class="btn btn-success" id="confirm-btn" style="width: 100%; margin-top: 1rem;">
                    Confirm Pick: ${state.selectedPlayer.name}
                </button>
            ` : ''}
        </div>
        <div class="card">
            <h3 class="card-title">Draft History</h3>
            <div class="draft-history">
                ${state.draftPicks.map(pick => {
                    const player = state.leagueData.players[pick.playerId] || {};
                    const formatPickNumber = (pickNum) => {
                        const round = Math.floor((pickNum - 1) / state.draftOrder.length) + 1;
                        const pickInRound = ((pickNum - 1) % state.draftOrder.length) + 1;
                        return `${round}.${pickInRound.toString().padStart(2, '0')}`;
                    };
                    const originalTeam = pick.originalOwnerId === 'FA' ? 'Free Agent' : pick.originalOwnerId;
                    return `
                        <div class="draft-pick">
                            <div>
                                <span style="color: #94a3b8; font-size: 0.875rem;">${formatPickNumber(pick.pickNumber)}</span>
                                <span style="color: white; font-weight: 600; margin-left: 0.5rem;">${player.full_name}</span>
                                <span style="color: #94a3b8; font-size: 0.875rem; margin-left: 0.5rem;">(${player.position})</span>
                            </div>
                            <div style="display: flex; gap: 1rem; align-items: center; font-size: 0.875rem;">
                                <span style="color: #60a5fa;">${originalTeam}</span>
                                <span style="color: #94a3b8;">→</span>
                                <span style="color: #6ee7b7;">${pick.teamId}</span>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    setupDraftEventListeners(container, filtered);
}

function renderRosterBoard(container, availablePlayers, currentDrafter) {
    const formatPickNumber = (pickNum) => {
        const round = Math.floor((pickNum - 1) / state.draftOrder.length) + 1;
        const pickInRound = ((pickNum - 1) % state.draftOrder.length) + 1;
        return `${round}.${pickInRound.toString().padStart(2, '0')}`;
    };

    const draftStarted = isDraftStarted();
    const draftComplete = isDraftComplete();
    const countdown = getCountdownToDraftStart();
    
    let statusHTML = '';
    let adminHTML = '';
    
    if (!state.adminAuthenticated) {
        adminHTML = `
            <div style="margin-bottom: 1rem;">
                <button class="btn btn-primary" id="admin-login-btn" style="font-size: 0.875rem; padding: 0.5rem 1rem;">🔐 Admin Login</button>
            </div>
        `;
    } else {
        adminHTML = `
            <div class="info-box" style="margin-bottom: 1rem;">
                <p>✓ Admin authenticated. You can now manage the draft.</p>
                <button class="btn btn-danger" id="admin-logout-btn" style="margin-top: 0.5rem; padding: 0.5rem 1rem; font-size: 0.875rem;">Logout</button>
            </div>
        `;
    }
    
    if (!draftStarted && !state.adminAuthenticated) {
        statusHTML = `
            <div class="warning-box" style="margin-bottom: 1rem;">
                <p><strong>Draft starts in:</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s</p>
                <p style="margin-top: 0.5rem; font-size: 0.875rem;">April 10th, 2026 at 7:00 PM ET</p>
            </div>
        `;
    } else if (!draftStarted && state.adminAuthenticated) {
        statusHTML = `
            <div class="warning-box" style="margin-bottom: 1rem;">
                <p><strong>Draft has not started yet.</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s remaining</p>
                <button class="btn btn-success" id="admin-start-draft-btn" style="margin-top: 0.5rem;">▶️ Start Draft Now (Admin)</button>
            </div>
        `;
    } else if (draftComplete) {
        statusHTML = `
            <div class="info-box" style="margin-bottom: 1rem;">
                <p>✓ Draft Complete! All 12 rounds finished.</p>
            </div>
        `;
    }

    container.innerHTML = `
        <div class="card">
            ${adminHTML}
            ${statusHTML}
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <div class="draft-header" style="margin-bottom: 0;">
                    <div class="draft-info">
                        <h2>Pick #${state.currentPick + 1} / ${MAX_DRAFT_PICKS}</h2>
                        <p>Now drafting: <strong style="color: white;">${currentDrafter}</strong></p>
                    </div>
                    <div class="draft-timer">
                        <div class="timer-display"><span>⏰</span>${formatTime(state.timeRemaining)}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-secondary" id="toggle-view-btn">📊 Table View</button>
                    ${state.adminAuthenticated ? `<button class="btn btn-danger" id="admin-reset-draft-btn">🔄 Reset Draft (Admin)</button>` : ''}
                </div>
            </div>
            <div class="input-group" style="max-width: 400px; margin-bottom: 1rem;">
                <input type="text" id="player-search" placeholder="Search player by name..." value="${state.searchTerm}" style="padding: 0.75rem; font-size: 1rem;">
            </div>
            <div class="filter-buttons">
                ${['ALL', ...POSITION_ORDER].map(pos => `
                    <button class="filter-btn ${state.positionFilter === pos ? 'active' : ''}" data-filter="${pos}">${pos}</button>
                `).join('')}
            </div>
        </div>
        <div class="grid-2">
            <div>
                <div class="card">
                    <h3 style="color: white; margin-bottom: 1rem;">Available Players</h3>
                    <div class="table-container" style="max-height: 600px;">
                        <table class="player-table">
                            <thead>
                                <tr>
                                    <th>Overall</th>
                                    <th>Pos Rank</th>
                                    <th>Player</th>
                                    <th>Team</th>
                                    <th>Owner</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${(state.positionFilter === 'ALL' ? availablePlayers : availablePlayers.filter(p => p.position === state.positionFilter)).filter(p => fuzzyMatch(p.name, state.searchTerm)).map(player => {
                                    const canDraft = state.dispersed.has(player.originalOwnerId) || getTeamPicksCount(player.originalOwnerId) < getMaxPicksPerTeam();
                                    const isSelected = state.selectedPlayer?.playerId === player.playerId;
                                    return `
                                        <tr class="${isSelected ? 'selected' : ''}" data-player-id="${player.playerId}" data-owner-id="${player.originalOwnerId}"
                                            style="cursor: ${!canDraft ? 'not-allowed' : 'pointer'}; opacity: ${!canDraft ? '0.5' : '1'}">
                                            <td><span class="rank-badge">#${player.overallRank}</span></td>
                                            <td><span class="rank-badge">${player.position} ${player.posRank}</span></td>
                                            <td style="font-weight: 600;">${player.name}</td>
                                            <td>${player.team}</td>
                                            <td style="font-size: 0.875rem; color: #94a3b8;">${player.ownerName}</td>
                                            <td>${!canDraft ? '<span style="color: #f87171;">Max</span>' : isSelected ? '✓' : ''}</td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${state.selectedPlayer ? `
                        <button class="btn btn-success" id="confirm-btn" style="width: 100%; margin-top: 1rem;">
                            Confirm Pick: ${state.selectedPlayer.name}
                        </button>
                    ` : ''}
                </div>
            </div>
            <div>
                ${state.draftOrder.map(teamId => {
                    const roster = getTeamRoster(teamId);
                    const { slots: rosterBySlot, benchPicks } = fillRosterSlots(roster);
                    return `
                        <div class="team-roster">
                            <div class="team-header">
                                <strong style="color: white;">${teamId}</strong>
                                <span style="color: #94a3b8; font-size: 0.875rem;">${roster.length} picks</span>
                            </div>
                            ${ROSTER_SLOTS.map((slot, idx) => {
                                const pick = rosterBySlot[idx];
                                if (pick) {
                                    const player = state.leagueData.players[pick.playerId] || {};
                                    return `
                                        <div class="roster-slot filled">
                                            <div>
                                                <div class="roster-slot-label">${slot}</div>
                                                <div class="roster-slot-player">${player.full_name} (${player.position})</div>
                                            </div>
                                            <span style="color: #94a3b8; font-size: 0.75rem;">${formatPickNumber(pick.pickNumber)}</span>
                                        </div>
                                    `;
                                } else {
                                    return `
                                        <div class="roster-slot">
                                            <div class="roster-slot-label">${slot}</div>
                                            <div class="roster-slot-empty">Empty</div>
                                        </div>
                                    `;
                                }
                            }).join('')}
                            ${benchPicks.length > 0 ? `
                                <div class="bench-section">
                                    <div class="bench-label">Bench</div>
                                    ${benchPicks.map(pick => {
                                        const player = state.leagueData.players[pick.playerId] || {};
                                        return `
                                            <div class="roster-slot filled">
                                                <div>
                                                    <div class="roster-slot-label">BENCH</div>
                                                    <div class="roster-slot-player">${player.full_name} (${player.position})</div>
                                                </div>
                                                <span style="color: #94a3b8; font-size: 0.75rem;">${formatPickNumber(pick.pickNumber)}</span>
                                            </div>
                                        `;
                                    }).join('')}
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    setupDraftEventListeners(container, availablePlayers);
}

function setupDraftEventListeners(container, playerPool) {
    // Admin login
    const adminLoginBtn = document.getElementById('admin-login-btn');
    if (adminLoginBtn) {
        adminLoginBtn.addEventListener('click', () => {
            const password = prompt('Enter admin password:');
            if (password === null) return; // Cancelled
            
            if (password === 'admin123') {
                state.adminAuthenticated = true;
                renderDraftView(container);
            } else {
                alert('Incorrect password.');
            }
        });
    }
    
    // Admin logout
    const adminLogoutBtn = document.getElementById('admin-logout-btn');
    if (adminLogoutBtn) {
        adminLogoutBtn.addEventListener('click', () => {
            state.adminAuthenticated = false;
            renderDraftView(container);
        });
    }
    
    // Admin start draft
    const adminStartDraftBtn = document.getElementById('admin-start-draft-btn');
    if (adminStartDraftBtn) {
        adminStartDraftBtn.addEventListener('click', () => {
            if (state.draftOrder.length === 0) {
                alert('Cannot start draft: No teams in draft order.');
                return;
            }
            if (confirm('Start the draft now? This cannot be undone.')) {
                // Draft is now considered started by admin
                // Update time to simulate start
                const newStartTime = new Date();
                newStartTime.setSeconds(newStartTime.getSeconds() - 1);
                // We'll mark it as started by setting a flag
                state.draftStartedByAdmin = true;
                renderDraftView(container);
            }
        });
    }
    
    // Admin reset draft
    const adminResetDraftBtn = document.getElementById('admin-reset-draft-btn');
    if (adminResetDraftBtn) {
        adminResetDraftBtn.addEventListener('click', () => {
            if (confirm('Reset the entire draft AND re-lock it? This will clear all picks and return the draft to locked status.')) {
                state.draftPicks = [];
                state.currentPick = 0;
                state.timeRemaining = PICK_TIME_LIMIT;
                state.selectedPlayer = null;
                state.draftStartedByAdmin = false;
                saveDraftPicks([]);
                stopTimer();
                renderDraftView(container);
                alert('Draft has been reset and re-locked.');
            }
        });
    }
    
    const searchInput = document.getElementById('player-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.searchTerm = e.target.value;
            updatePlayerTableSearch(playerPool);
        });
    }
    
    // Update countdown timer every second if draft hasn't started
    if (!isDraftStarted()) {
        const countdownInterval = setInterval(() => {
            const countdown = getCountdownToDraftStart();
            if (countdown.started) {
                clearInterval(countdownInterval);
                renderDraftView(container);
            } else {
                const statusBoxes = document.querySelectorAll('.warning-box');
                statusBoxes.forEach(box => {
                    if (box.textContent.includes('Draft starts in:')) {
                        box.innerHTML = `
                            <p><strong>Draft starts in:</strong> ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s</p>
                            <p style="margin-top: 0.5rem; font-size: 0.875rem;">April 10th, 2026 at 7:00 PM ET</p>
                        `;
                    }
                });
            }
        }, 1000);
    }
    
    document.querySelectorAll('[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.positionFilter = btn.dataset.filter;
            renderDraftView(container);
        });
    });

    document.querySelectorAll('[data-player-id]').forEach(item => {
        const tr = item.closest('tr');
        if (!tr.style.cursor.includes('not-allowed')) {
            item.addEventListener('click', () => {
                const player = playerPool.find(p => p.playerId === item.dataset.playerId);
                state.selectedPlayer = player;
                renderDraftView(container);
            });
        }
    });

    if (state.selectedPlayer && document.getElementById('confirm-btn')) {
        document.getElementById('confirm-btn').addEventListener('click', () => {
            makeDraftPick(state.selectedPlayer);
        });
    }



    if (document.getElementById('toggle-view-btn')) {
        document.getElementById('toggle-view-btn').addEventListener('click', () => {
            state.draftView = state.draftView === 'table' ? 'roster' : 'table';
            renderDraftView(container);
        });
    }

    if (isDraftStarted() && state.currentPick < MAX_DRAFT_PICKS) {
        startTimer();
    }
}

function fillRosterSlots(picks) {
    const slots = new Array(ROSTER_SLOTS.length).fill(null);
    const sortedPicks = [...picks].sort((a, b) => a.pickNumber - b.pickNumber);
    let benchPicks = [];

    sortedPicks.forEach(pick => {
        const player = state.leagueData.players[pick.playerId] || {};
        const pos = player.position || '?';
        let assigned = false;

        for (let i = 0; i < ROSTER_SLOTS.length; i++) {
            if (slots[i] === null) {
                const slotName = ROSTER_SLOTS[i];
                
                if (slotName === pos) {
                    slots[i] = pick;
                    assigned = true;
                    return;
                } else if (slotName === 'FLEX' && ['RB', 'WR', 'TE'].includes(pos)) {
                    slots[i] = pick;
                    assigned = true;
                    return;
                } else if (slotName === 'SUPERFLEX' && ['QB', 'RB', 'WR', 'TE'].includes(pos)) {
                    slots[i] = pick;
                    assigned = true;
                    return;
                } else if (slotName === 'DL' && (pos === 'DL' || pos === 'DE')) {
                    slots[i] = pick;
                    assigned = true;
                    return;
                } else if (slotName === 'LB' && pos === 'LB') {
                    slots[i] = pick;
                    assigned = true;
                    return;
                } else if (slotName === 'DB' && pos === 'DB') {
                    slots[i] = pick;
                    assigned = true;
                    return;
                }
            }
        }
        
        if (!assigned) {
            benchPicks.push(pick);
        }
    });

    return { slots, benchPicks };
}

function getAvailablePlayers() {
    const draftedIds = new Set(state.draftPicks.map(p => p.playerId));
    const pool = [];
    
    // Get all rostered players
    const rosteredPlayerIds = new Set();
    state.leagueData.rosters.forEach(roster => {
        (roster.players || []).forEach(pid => rosteredPlayerIds.add(pid));
    });
    
    // Add rostered players (existing logic)
    state.leagueData.rosters.forEach(roster => {
        const ownerId = roster.owner_id;
        const isDispersed = state.dispersed.has(ownerId);
        const protectionData = state.protections[ownerId];
        let protectedIds = [];
        
        if (Array.isArray(protectionData)) {
            protectedIds = protectionData;
        } else if (protectionData && protectionData.players) {
            protectedIds = protectionData.players;
        }
        
        (roster.players || []).forEach(playerId => {
            if (!draftedIds.has(playerId) && !protectedIds.includes(playerId)) {
                const player = state.leagueData.players[playerId] || {};
                const ranking = state.rankings[playerId] || { overallRank: 9999, posRank: 999 };
                
                pool.push({
                    playerId,
                    name: player.full_name || playerId,
                    position: player.position || '?',
                    team: player.team || 'FA',
                    originalOwnerId: ownerId,
                    ownerName: state.leagueData.ownerMap[ownerId],
                    overallRank: ranking.overallRank,
                    posRank: ranking.posRank
                });
            }
        });
    });
    
    // Add free agents (not on any roster)
    Object.entries(state.leagueData.players).forEach(([playerId, player]) => {
        if (!rosteredPlayerIds.has(playerId) && !draftedIds.has(playerId)) {
            // Only include NFL players (exclude practice squad, retired, etc.)
            if (player.active && player.team && player.team !== 'None') {
                const ranking = state.rankings[playerId] || { overallRank: 9999, posRank: 999 };
                
                pool.push({
                    playerId,
                    name: player.full_name || playerId,
                    position: player.position || '?',
                    team: player.team || 'FA',
                    originalOwnerId: null,
                    ownerName: 'Free Agent',
                    overallRank: ranking.overallRank,
                    posRank: ranking.posRank
                });
            }
        }
    });
    
    return pool.sort((a, b) => a.overallRank - b.overallRank);
}

function getCurrentDrafter() {
    if (state.draftOrder.length === 0) return 'No teams in draft order';
    
    const round = Math.floor(state.currentPick / state.draftOrder.length);
    const isEvenRound = round % 2 === 0;
    const pickInRound = state.currentPick % state.draftOrder.length;
    
    return isEvenRound 
        ? state.draftOrder[pickInRound] 
        : state.draftOrder[state.draftOrder.length - 1 - pickInRound];
}

function getTeamRoster(teamId) {
    return state.draftPicks.filter(p => p.teamId === teamId);
}

function getTeamPicksCount(ownerId) {
    if (!ownerId || ownerId === 'FA') return 0; // Free agents don't count toward team limits
    return state.draftPicks.filter(p => p.originalOwnerId === ownerId).length;
}

function makeDraftPick(player) {
    // Check if draft has started or admin override
    if (!isDraftStarted() && !state.adminAuthenticated) {
        alert('Draft has not started yet. Please wait until April 10th at 7:00 PM ET.');
        return;
    }
    
    // Check if draft is complete
    if (isDraftComplete()) {
        alert('Draft is complete! All 12 rounds have been finished.');
        return;
    }
    
    const pick = {
        playerId: player.playerId,
        originalOwnerId: player.originalOwnerId || 'FA', // Handle free agents
        teamId: getCurrentDrafter(),
        pickNumber: state.currentPick + 1
    };
    
    state.draftPicks.push(pick);
    state.currentPick++;
    state.timeRemaining = PICK_TIME_LIMIT;
    state.selectedPlayer = null;
    
    saveDraftPicks(state.draftPicks);
    renderDraftView(document.getElementById('content'));
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function startTimer() {
    stopTimer();
    state.timerInterval = setInterval(() => {
        state.timeRemaining--;
        if (state.timeRemaining <= 0) {
            state.timeRemaining = 0;
            stopTimer();
        }
        const timerEl = document.querySelector('.timer-display');
        if (timerEl) {
            timerEl.innerHTML = `<span>⏰</span>${formatTime(state.timeRemaining)}`;
        }
    }, 1000);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

function startRosterRefresh() {
    // Refresh rosters every 30 seconds to detect trades
    state.rosterRefreshInterval = setInterval(async () => {
        try {
            const newLeagueData = await fetchLeagueData();
            
            // Compare rosters to detect if a trade occurred
            const hasChanges = JSON.stringify(state.leagueData.rosters) !== JSON.stringify(newLeagueData.rosters);
            
            if (hasChanges) {
                console.log('Rosters updated - trade detected');
                state.leagueData = newLeagueData;
                
                // Re-render if viewing league view
                if (state.currentView === 'league') {
                    renderView('league');
                }
            }
        } catch (error) {
            console.error('Error refreshing rosters:', error);
        }
    }, 30000); // Check every 30 seconds
}

function stopRosterRefresh() {
    if (state.rosterRefreshInterval) {
        clearInterval(state.rosterRefreshInterval);
        state.rosterRefreshInterval = null;
    }
}

init();                