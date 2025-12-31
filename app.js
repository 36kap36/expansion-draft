import { fetchLeagueData, fetchFantasyCalcRankings } from './api.js';
import { 
    saveProtections, loadProtections,
    saveDraftOrder, loadDraftOrder,
    saveDraftPicks, loadDraftPicks,
    saveDispersed, loadDispersed,
    resetAllData
} from './storage.js';

const POSITION_LIMITS = {
    QB: 1, RB: 2, WR: 3, TE: 1, IDP: 2, K: 1, FLEX: 3, SUPERFLEX: 1
};

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"];
const ROSTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX", "K", "DL", "LB", "DB"];
const MAX_FROM_EACH_TEAM = 3;
const PICK_TIME_LIMIT = 600;

// Global state
let state = {
    leagueData: null,
    rankings: {},
    currentView: 'protect',
    protections: loadProtections(),
    draftOrder: loadDraftOrder(),
    draftPicks: loadDraftPicks(),
    dispersed: new Set(loadDispersed()),
    currentPick: 0,
    timeRemaining: PICK_TIME_LIMIT,
    timerInterval: null,
    selectedPlayer: null,
    positionFilter: 'ALL',
    selectedOwner: null,
    selectedPlayers: [],
    ownerChoice: {},
    draftView: 'table' // 'table' or 'roster'
};

// Initialize app
async function init() {
    showLoading();
    
    try {
        state.leagueData = await fetchLeagueData();
        state.rankings = await fetchFantasyCalcRankings();
        state.currentPick = state.draftPicks.length;
        
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
        showError('Failed to load league data. Please refresh the page.');
    }
}

function showLoading() {
    document.getElementById('content').innerHTML = '<div class="loading">Loading league data...</div>';
}

function showError(message) {
    document.getElementById('content').innerHTML = `<div class="loading" style="color: #f87171;">${message}</div>`;
}

// Navigation
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

// Render views
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

// Protect View
function renderProtectView(container) {
    const owners = state.leagueData.rosters.map(r => ({
        id: r.owner_id,
        name: state.leagueData.ownerMap[r.owner_id],
        players: r.players || []
    }));

    if (!state.selectedOwner) {
        container.innerHTML = `
            <div class="card">
                <h2 class="card-title">
                    <span>🛡️</span>
                    Select Owner
                </h2>
                <div class="input-group">
                    <select id="owner-select">
                        <option value="">Choose an owner...</option>
                        ${owners.map(o => `<option value="${o.id}">${o.name}</option>`).join('')}
                    </select>
                </div>
            </div>
        `;

        document.getElementById('owner-select').addEventListener('change', (e) => {
            state.selectedOwner = e.target.value;
            if (state.selectedOwner) {
                const prot = state.protections[state.selectedOwner];
                if (Array.isArray(prot)) {
                    state.selectedPlayers = prot;
                } else if (prot && prot.players) {
                    state.selectedPlayers = prot.players;
                } else {
                    state.selectedPlayers = [];
                }
                renderProtectView(container);
            }
        });
        return;
    }

    const owner = owners.find(o => o.id === state.selectedOwner);
    const ownerName = state.leagueData.ownerMap[state.selectedOwner];
    const choice = state.ownerChoice[state.selectedOwner] || null;
    const counts = calculatePositionCounts(state.selectedPlayers);
    
    // Check if protections are locked
    const protectionData = state.protections[state.selectedOwner];
    const isLocked = protectionData && protectionData._locked;
    const savedPassword = protectionData ? protectionData._password : null;

    // Sort owner's players by position then FantasyCalc rank
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
        if (posA !== posB) return posA - posB;
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

    container.innerHTML = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h2 class="card-title">
                    <span>🛡️</span>
                    ${ownerName}
                </h2>
                <button class="btn btn-secondary" id="back-btn">← Back</button>
            </div>
        </div>

        <div class="card">
            <h3 style="color: white; margin-bottom: 1rem;">Choose Option</h3>
            
            ${isLocked ? `
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

        ${choice === 'protect' ? `
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
                        <button class="btn btn-primary" id="save-btn">Save & Lock Protections</button>
                    </div>
                </div>
                <div class="input-group" style="max-width: 300px;">
                    <label>Password (required to save and lock)</label>
                    <input type="password" id="password-input" placeholder="Enter password">
                </div>
                <div class="table-container">
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
        ` : choice === 'disperse' ? `
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

    // Unlock button handler
    if (isLocked && document.getElementById('unlock-btn')) {
        document.getElementById('unlock-btn').addEventListener('click', () => {
            const password = document.getElementById('unlock-password').value;
            if (password === savedPassword) {
                // Unlock by removing lock flags
                const currentProtections = state.protections[state.selectedOwner];
                if (Array.isArray(currentProtections)) {
                    state.selectedPlayers = currentProtections;
                } else {
                    state.selectedPlayers = currentProtections.players || [];
                }
                delete state.protections[state.selectedOwner];
                state.protections[state.selectedOwner] = state.selectedPlayers;
                saveProtections(state.protections);
                alert('Protections unlocked!');
                renderProtectView(container);
            } else {
                alert('Incorrect password!');
            }
        });
    }

    if (isLocked) return; // Don't set up other handlers if locked

    const protectRadio = document.getElementById('protect-radio');
    const disperseRadio = document.getElementById('disperse-radio');
    
    if (protectRadio && disperseRadio) {
        protectRadio.addEventListener('change', () => {
            state.ownerChoice[state.selectedOwner] = 'protect';
            state.dispersed.delete(state.selectedOwner);
            state.selectedPlayers = state.protections[state.selectedOwner] || [];
            renderProtectView(container);
        });
        
        disperseRadio.addEventListener('change', () => {
            state.ownerChoice[state.selectedOwner] = 'disperse';
            renderProtectView(container);
        });
    }

    if (choice === 'protect') {
        document.querySelectorAll('[data-player-id]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const playerId = item.dataset.playerId;
                if (state.selectedPlayers.includes(playerId)) {
                    state.selectedPlayers = state.selectedPlayers.filter(id => id !== playerId);
                } else {
                    state.selectedPlayers.push(playerId);
                }
                
                // Store scroll position
                const scrollPos = window.pageYOffset || document.documentElement.scrollTop;
                
                renderProtectView(container);
                
                // Restore scroll position
                window.scrollTo(0, scrollPos);
            });
        });

        document.getElementById('reset-protections-btn').addEventListener('click', () => {
            if (confirm('Reset all protections for this team? This will clear your selections.')) {
                state.selectedPlayers = [];
                delete state.protections[state.selectedOwner];
                saveProtections(state.protections);
                renderProtectView(container);
            }
        });

        document.getElementById('save-btn').addEventListener('click', () => {
            const password = document.getElementById('password-input').value;
            
            if (!password) {
                alert('Please enter a password to lock your protections.');
                return;
            }
            
            const counts = calculatePositionCounts(state.selectedPlayers);
            const errors = [];
            
            Object.entries(POSITION_LIMITS).forEach(([pos, limit]) => {
                if (counts[pos] > limit) {
                    errors.push(`${pos}: ${counts[pos]}/${limit} (over limit)`);
                }
            });
            
            if (errors.length > 0) {
                alert('Position limits exceeded:\n' + errors.join('\n'));
                return;
            }
            
            // Save with password and lock flag
            state.protections[state.selectedOwner] = {
                players: state.selectedPlayers,
                _password: password,
                _locked: true
            };
            saveProtections(state.protections);
            alert('Protections saved and locked!');
            renderProtectView(container);
        });
    }

    if (choice === 'disperse') {
        document.getElementById('save-disperse-btn').addEventListener('click', () => {
            state.dispersed.add(state.selectedOwner);
            state.protections[state.selectedOwner] = [];
            saveDispersed([...state.dispersed]);
            saveProtections(state.protections);
            alert('Team marked as dispersed!');
        });
    }
}

// Setup View
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
                <h2 class="card-title" style="margin-bottom: 0;">
                    <span>👥</span>
                    Draft Order
                </h2>
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

// League View
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
            <h2 class="card-title">
                <span>🏈</span>
                League Rosters
            </h2>
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
                if (posA !== posB) return posA - posB;
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

// Draft View
function renderDraftView(container) {
    const availablePlayers = getAvailablePlayers();
    const filtered = state.positionFilter === 'ALL' 
        ? availablePlayers 
        : availablePlayers.filter(p => p.position === state.positionFilter);

    const currentDrafter = getCurrentDrafter();
    
    if (state.draftView === 'roster') {
        renderRosterBoard(container, availablePlayers, currentDrafter);
    } else {
        renderTableView(container, filtered, currentDrafter);
    }
}

function renderTableView(container, filtered, currentDrafter) {
    container.innerHTML = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <div class="draft-header" style="margin-bottom: 0;">
                    <div class="draft-info">
                        <h2>Pick #${state.currentPick + 1}</h2>
                        <p>Now drafting: <strong style="color: white;">${currentDrafter}</strong></p>
                    </div>
                    <div class="draft-timer">
                        <div class="timer-display">
                            <span>⏰</span>
                            ${formatTime(state.timeRemaining)}
                        </div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-secondary" id="toggle-view-btn">📋 Roster View</button>
                    <button class="btn btn-danger" id="reset-btn">Reset Draft</button>
                </div>
            </div>

            <div class="filter-buttons">
                ${['ALL', ...POSITION_ORDER].map(pos => `
                    <button class="filter-btn ${state.positionFilter === pos ? 'active' : ''}" data-filter="${pos}">
                        ${pos}
                    </button>
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
                            <th>Owner</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${filtered.map(player => {
                            const canDraft = getTeamPicksCount(player.originalOwnerId) < MAX_FROM_EACH_TEAM;
                            const isSelected = state.selectedPlayer?.playerId === player.playerId;
                            return `
                                <tr class="${isSelected ? 'selected' : ''}" 
                                    data-player-id="${player.playerId}"
                                    data-owner-id="${player.originalOwnerId}"
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
                    return `
                        <div class="draft-pick">
                            <div>
                                <span style="color: #94a3b8; font-size: 0.875rem;">${formatPickNumber(pick.pickNumber)}</span>
                                <span style="color: white; font-weight: 600; margin-left: 0.5rem;">${player.full_name}</span>
                                <span style="color: #94a3b8; font-size: 0.875rem; margin-left: 0.5rem;">(${player.position})</span>
                            </div>
                            <span style="color: #60a5fa; font-size: 0.875rem;">${pick.teamId}</span>
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

    container.innerHTML = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <div class="draft-header" style="margin-bottom: 0;">
                    <div class="draft-info">
                        <h2>Pick #${state.currentPick + 1}</h2>
                        <p>Now drafting: <strong style="color: white;">${currentDrafter}</strong></p>
                    </div>
                    <div class="draft-timer">
                        <div class="timer-display">
                            <span>⏰</span>
                            ${formatTime(state.timeRemaining)}
                        </div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-secondary" id="toggle-view-btn">📊 Table View</button>
                    <button class="btn btn-danger" id="reset-btn">Reset Draft</button>
                </div>
            </div>

            <div class="filter-buttons">
                ${['ALL', ...POSITION_ORDER].map(pos => `
                    <button class="filter-btn ${state.positionFilter === pos ? 'active' : ''}" data-filter="${pos}">
                        ${pos}
                    </button>
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
                                    <th>Pos</th>
                                    <th>Player</th>
                                    <th>Team</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${(state.positionFilter === 'ALL' ? availablePlayers : availablePlayers.filter(p => p.position === state.positionFilter)).map(player => {
                                    const canDraft = getTeamPicksCount(player.originalOwnerId) < MAX_FROM_EACH_TEAM;
                                    const isSelected = state.selectedPlayer?.playerId === player.playerId;
                                    return `
                                        <tr class="${isSelected ? 'selected' : ''}" 
                                            data-player-id="${player.playerId}"
                                            data-owner-id="${player.originalOwnerId}"
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
                    const rosterBySlot = fillRosterSlots(roster);

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
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    setupDraftEventListeners(container, availablePlayers);
}

function setupDraftEventListeners(container, playerPool) {
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

    document.getElementById('reset-btn').addEventListener('click', () => {
        if (confirm('Reset the entire draft? This cannot be undone.')) {
            state.draftPicks = [];
            state.currentPick = 0;
            state.timeRemaining = PICK_TIME_LIMIT;
            state.selectedPlayer = null;
            saveDraftPicks([]);
            stopTimer();
            renderDraftView(container);
        }
    });

    if (document.getElementById('toggle-view-btn')) {
        document.getElementById('toggle-view-btn').addEventListener('click', () => {
            state.draftView = state.draftView === 'table' ? 'roster' : 'table';
            renderDraftView(container);
        });
    }

    if (state.currentPick < 100) {
        startTimer();
    }
}

// Helper functions
function fillRosterSlots(picks) {
    const slots = new Array(ROSTER_SLOTS.length).fill(null);
    const sortedPicks = [...picks].sort((a, b) => a.pickNumber - b.pickNumber);

    sortedPicks.forEach(pick => {
        const player = state.leagueData.players[pick.playerId] || {};
        const pos = player.position || '?';

        for (let i = 0; i < ROSTER_SLOTS.length; i++) {
            if (slots[i] === null) {
                const slotName = ROSTER_SLOTS[i];
                
                if (slotName === pos) {
                    slots[i] = pick;
                    return;
                } else if (slotName === 'FLEX' && ['RB', 'WR', 'TE'].includes(pos)) {
                    slots[i] = pick;
                    return;
                } else if (slotName === 'SUPERFLEX' && ['QB', 'RB', 'WR', 'TE'].includes(pos)) {
                    slots[i] = pick;
                    return;
                } else if (slotName === 'DL' && pos === 'DL') {
                    slots[i] = pick;
                    return;
                } else if (slotName === 'LB' && pos === 'LB') {
                    slots[i] = pick;
                    return;
                } else if (slotName === 'DB' && pos === 'DB') {
                    slots[i] = pick;
                    return;
                }
            }
        }
    });

    return slots;
}

function calculatePositionCounts(playerIds) {
    const counts = {};
    Object.keys(POSITION_LIMITS).forEach(k => counts[k] = 0);
    
    const used = {
        QB: 0, RB: 0, WR: 0, TE: 0, K: 0, IDP: 0,
        FLEX: 0, SUPERFLEX: 0
    };
    
    playerIds.forEach(pid => {
        const pos = state.leagueData.players[pid]?.position || '?';
        
        if (pos === 'QB' && used.QB < POSITION_LIMITS.QB) {
            used.QB++;
            counts.QB++;
        } else if (pos === 'RB' && used.RB < POSITION_LIMITS.RB) {
            used.RB++;
            counts.RB++;
        } else if (pos === 'WR' && used.WR < POSITION_LIMITS.WR) {
            used.WR++;
            counts.WR++;
        } else if (pos === 'TE' && used.TE < POSITION_LIMITS.TE) {
            used.TE++;
            counts.TE++;
        } else if (pos === 'K' && used.K < POSITION_LIMITS.K) {
            used.K++;
            counts.K++;
        } else if ((pos === 'DL' || pos === 'LB' || pos === 'DB') && used.IDP < POSITION_LIMITS.IDP) {
            used.IDP++;
            counts.IDP++;
        }
        else if ((pos === 'RB' || pos === 'WR' || pos === 'TE') && used.FLEX < POSITION_LIMITS.FLEX) {
            used.FLEX++;
            counts.FLEX++;
        }
        else if ((pos === 'QB' || pos === 'RB' || pos === 'WR' || pos === 'TE') && used.SUPERFLEX < POSITION_LIMITS.SUPERFLEX) {
            used.SUPERFLEX++;
            counts.SUPERFLEX++;
        }
    });
    
    return counts;
}

function getAvailablePlayers() {
    const draftedIds = new Set(state.draftPicks.map(p => p.playerId));
    const pool = [];
    
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
    return state.draftPicks.filter(p => p.originalOwnerId === ownerId).length;
}

function makeDraftPick(player) {
    const pick = {
        playerId: player.playerId,
        originalOwnerId: player.originalOwnerId,
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
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
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

// Start the app
init();