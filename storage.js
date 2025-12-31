const STORAGE_KEYS = {
    PROTECTIONS: 'expansion_draft_protections',
    DRAFT_ORDER: 'expansion_draft_order',
    DRAFT_PICKS: 'expansion_draft_picks',
    DISPERSED: 'expansion_draft_dispersed'
};

export function saveProtections(protections) {
    localStorage.setItem(STORAGE_KEYS.PROTECTIONS, JSON.stringify(protections));
}

export function loadProtections() {
    const data = localStorage.getItem(STORAGE_KEYS.PROTECTIONS);
    return data ? JSON.parse(data) : {};
}

export function saveDraftOrder(order) {
    localStorage.setItem(STORAGE_KEYS.DRAFT_ORDER, JSON.stringify(order));
}

export function loadDraftOrder() {
    const data = localStorage.getItem(STORAGE_KEYS.DRAFT_ORDER);
    return data ? JSON.parse(data) : [];
}

export function saveDraftPicks(picks) {
    localStorage.setItem(STORAGE_KEYS.DRAFT_PICKS, JSON.stringify(picks));
}

export function loadDraftPicks() {
    const data = localStorage.getItem(STORAGE_KEYS.DRAFT_PICKS);
    return data ? JSON.parse(data) : [];
}

export function saveDispersed(dispersed) {
    localStorage.setItem(STORAGE_KEYS.DISPERSED, JSON.stringify(dispersed));
}

export function loadDispersed() {
    const data = localStorage.getItem(STORAGE_KEYS.DISPERSED);
    return data ? JSON.parse(data) : [];
}

export function resetAllData() {
    Object.values(STORAGE_KEYS).forEach(key => {
        localStorage.removeItem(key);
    });
}