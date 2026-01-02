import { saveToFirebase, loadFromFirebase } from './firebase.js';

const STORAGE_KEYS = {
    PROTECTIONS: 'protections',
    DRAFT_ORDER: 'draft_order',
    DRAFT_PICKS: 'draft_picks',
    DISPERSED: 'dispersed'
};

export async function saveProtections(protections) {
    await saveToFirebase(STORAGE_KEYS.PROTECTIONS, protections);
}

export async function loadProtections() {
    const data = await loadFromFirebase(STORAGE_KEYS.PROTECTIONS);
    return data || {};
}

export async function saveDraftOrder(order) {
    await saveToFirebase(STORAGE_KEYS.DRAFT_ORDER, order);
}

export async function loadDraftOrder() {
    const data = await loadFromFirebase(STORAGE_KEYS.DRAFT_ORDER);
    return data || [];
}

export async function saveDraftPicks(picks) {
    await saveToFirebase(STORAGE_KEYS.DRAFT_PICKS, picks);
}

export async function loadDraftPicks() {
    const data = await loadFromFirebase(STORAGE_KEYS.DRAFT_PICKS);
    return data || [];
}

export async function saveDispersed(dispersed) {
    await saveToFirebase(STORAGE_KEYS.DISPERSED, dispersed);
}

export async function loadDispersed() {
    const data = await loadFromFirebase(STORAGE_KEYS.DISPERSED);
    return data || [];
}

export async function resetAllData() {
    await saveProtections({});
    await saveDraftOrder([]);
    await saveDraftPicks([]);
    await saveDispersed([]);
}