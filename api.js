const LEAGUE_ID = "1180223058695053312";
const BASE_URL = "https://api.sleeper.app/v1";

export async function fetchLeagueData() {
    try {
        const [rostersRes, usersRes, playersRes] = await Promise.all([
            fetch(`${BASE_URL}/league/${LEAGUE_ID}/rosters`),
            fetch(`${BASE_URL}/league/${LEAGUE_ID}/users`),
            fetch(`${BASE_URL}/players/nfl`)
        ]);

        const rosters = await rostersRes.json();
        const users = await usersRes.json();
        const players = await playersRes.json();

        const ownerMap = {};
        users.forEach(u => {
            ownerMap[u.user_id] = u.display_name || u.username || 'Unknown';
        });

        return { rosters, ownerMap, players };
    } catch (error) {
        console.error('Error fetching league data:', error);
        throw error;
    }
}

export async function fetchFantasyCalcRankings() {
    try {
        const url = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=10&ppr=1";
        const response = await fetch(url);
        const data = await response.json();

        const rankings = {};
        data.forEach(entry => {
            const player = entry.player || {};
            const sleeperId = String(player.sleeperId);
            rankings[sleeperId] = {
                overallRank: entry.overallRank || 9999,
                posRank: entry.positionRank || 999
            };
        });

        return rankings;
    } catch (error) {
        console.error('Error fetching FantasyCalc rankings:', error);
        return {};
    }
}