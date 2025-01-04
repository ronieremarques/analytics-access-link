const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const useragent = require('express-useragent');
const geoip = require('geoip-lite');

const app = express();
const port = process.env.PORT || 8080;
const ANALYTICS_FILE = 'analytics_data.json';
const COUNTERS_FILE = 'counters.json';

// Middleware
app.use(express.static('public'))
app.use(express.json());
app.use(useragent.express());

// Função para ler dados do arquivo
async function readAnalyticsData() {
    try {
        const data = await fs.readFile(ANALYTICS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

// Função para ler contadores
async function readCounters() {
    try {
        const data = await fs.readFile(COUNTERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { pageViews: 0, uniqueVisitors: [] };
    }
}

// Função para salvar contadores
async function saveCounters(counters) {
    try {
        await fs.writeFile(COUNTERS_FILE, JSON.stringify(counters, null, 2));
    } catch (error) {
        console.error('Erro ao salvar contadores:', error);
    }
}

// Função para salvar dados no arquivo
async function saveAnalyticsData(data) {
    try {
        await fs.writeFile(ANALYTICS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Erro ao salvar dados:', error);
    }
}

// Função para incrementar visualizações
async function incrementPageViews(ip) {
    try {
        const counters = await readCounters();
        counters.pageViews++;
        
        // Verificar se é um visitante único usando o IP completo
        if (!counters.uniqueVisitors.includes(ip)) {
            counters.uniqueVisitors.push(ip);
        }
        
        await saveCounters(counters);
        return counters;
    } catch (error) {
        console.error('Erro ao incrementar visualizações:', error);
        return null;
    }
}

// Função para obter informações de localização
function getLocationInfo(ip) {
    try {
        // Não remover mais o prefixo ::ffff: para manter o IP original completo
        const geo = geoip.lookup(ip);
        return geo || {
            country: 'Desconhecido',
            region: 'Desconhecido',
            city: 'Desconhecido',
            timezone: 'Desconhecido',
            ll: [0, 0] // latitude, longitude
        };
    } catch (error) {
        console.error('Erro ao obter localização:', error);
        return {
            country: 'Erro',
            region: 'Erro',
            city: 'Erro',
            timezone: 'Erro',
            ll: [0, 0]
        };
    }
}

// Função para processar dados do usuário
function processUserData(data, req) {
    const now = new Date();
    const fullIp = req.ip; // Usar o IP completo
    return {
        ...data,
        ip: fullIp,
        userAgent: req.useragent,
        location: getLocationInfo(fullIp),
        lastUpdate: now.toISOString(),
        sessionInfo: {
            ...data.sessionInfo,
            lastActive: now.toISOString(),
            tabFocused: data.sessionInfo?.tabFocused ?? true,
            browserInfo: {
                name: req.useragent.browser,
                version: req.useragent.version,
                os: req.useragent.os,
                platform: req.useragent.platform,
                isMobile: req.useragent.isMobile,
                isTablet: req.useragent.isTablet,
                isDesktop: req.useragent.isDesktop
            }
        },
        trafficSource: {
            referrer: data.trafficSource?.referrer || 'Direto',
            campaign: data.trafficSource?.campaign || 'Nenhuma',
            medium: data.trafficSource?.medium || 'Direto',
            source: data.trafficSource?.source || 'Direto'
        }
    };
}

// Endpoint para salvar dados de analytics
app.post('/api/analytics', async (req, res) => {
    try {
        const analyticsData = req.body;
        const allData = await readAnalyticsData();
        const fullIp = req.ip; // Usar o IP completo
        
        // Incrementar visualizações apenas se for um evento page_view
        if (analyticsData.eventType === 'page_view' && analyticsData.pageType === 'index') {
            await incrementPageViews(fullIp);
        }

        // Verificar se já existe uma sessão para este usuário/IP
        const existingSessionIndex = allData.findIndex(
            session => session.sessionId === analyticsData.sessionId || session.ip === fullIp
        );

        const processedData = processUserData(analyticsData, req);

        if (existingSessionIndex !== -1) {
            // Atualizar sessão existente
            const existingSession = allData[existingSessionIndex];
            const updatedSession = {
                ...existingSession,
                ...processedData,
                totalTimeOnPage: Math.round((new Date(processedData.lastUpdate) - new Date(existingSession.startTime)) / 1000),
                sessionEvents: [
                    ...(existingSession.sessionEvents || []),
                    {
                        type: analyticsData.eventType || 'update',
                        timestamp: new Date().toISOString(),
                        data: analyticsData.eventData || {}
                    }
                ]
            };
            allData[existingSessionIndex] = updatedSession;
        } else {
            // Criar nova sessão
            const newSession = {
                ...processedData,
                startTime: new Date().toISOString(),
                sessionEvents: [{
                    type: 'session_start',
                    timestamp: new Date().toISOString(),
                    data: {}
                }]
            };
            allData.push(newSession);
        }

        await saveAnalyticsData(allData);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Erro ao processar analytics:', error);
        res.status(500).json({ error: 'Erro ao salvar dados' });
    }
});

// Endpoint para obter dados de analytics
app.get('/api/analytics', async (req, res) => {
    try {
        const data = await readAnalyticsData();
        res.json(data);
    } catch (error) {
        console.error('Erro ao ler analytics:', error);
        res.status(500).json({ error: 'Erro ao ler dados' });
    }
});

// Endpoint para obter estatísticas agregadas
app.get('/api/analytics/stats', async (req, res) => {
    try {
        const data = await readAnalyticsData();
        const counters = await readCounters();
        
        // Estatísticas de visualizações e usuários
        const viewStats = {
            totalViews: counters.pageViews,
            uniqueUsers: counters.uniqueVisitors.length,
            newUsers: 0,
            returningUsers: 0
        };

        // Mapear IPs e suas visitas
        const userVisits = {};
        const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        data.forEach(session => {
            const ip = session.ip;
            const visitDate = new Date(session.startTime);
            
            if (!userVisits[ip]) {
                userVisits[ip] = {
                    firstVisit: visitDate,
                    visits: []
                };
            }
            
            userVisits[ip].visits.push(visitDate);
            
            if (visitDate < userVisits[ip].firstVisit) {
                userVisits[ip].firstVisit = visitDate;
            }
        });

        // Calcular usuários novos e recorrentes nas últimas 24h
        Object.entries(userVisits).forEach(([ip, data]) => {
            const recentVisits = data.visits.filter(date => date > last24Hours);
            
            if (recentVisits.length > 0) {
                if (data.firstVisit > last24Hours) {
                    viewStats.newUsers++;
                } else if (recentVisits.length > 1 || data.visits.length > 1) {
                    viewStats.returningUsers++;
                }
            }
        });

        // Estatísticas de tendência
        const trends = {
            last24h: data.filter(session => new Date(session.startTime) > last24Hours).length,
            last7d: data.filter(session => new Date(session.startTime) > last7Days).length,
            averageTimeOnPage: Math.round(
                data.reduce((acc, session) => acc + (session.totalTimeOnPage || 0), 0) / 
                data.length
            )
        };

        // Estatísticas por país
        const paisesStats = {};
        data.forEach(session => {
            const pais = session.location.country;
            if (!paisesStats[pais]) {
                paisesStats[pais] = {
                    sessoes: 0,
                    tempoTotal: 0,
                    cliquesTotal: 0,
                    usuarios: new Set()
                };
            }
            paisesStats[pais].sessoes++;
            paisesStats[pais].tempoTotal += session.totalTimeOnPage || 0;
            paisesStats[pais].cliquesTotal += session.clicks?.length || 0;
            paisesStats[pais].usuarios.add(session.ip);
        });

        // Converter Set para número
        Object.values(paisesStats).forEach(stat => {
            stat.usuarios = stat.usuarios.size;
        });

        // Estatísticas por hora
        const horasStats = Array(24).fill(0).map(() => ({
            sessoes: 0,
            tempoMedio: 0,
            usuarios: new Set()
        }));

        data.forEach(session => {
            const hora = new Date(session.startTime).getHours();
            horasStats[hora].sessoes++;
            horasStats[hora].tempoMedio += session.totalTimeOnPage || 0;
            horasStats[hora].usuarios.add(session.ip);
        });

        horasStats.forEach(stat => {
            if (stat.sessoes > 0) {
                stat.tempoMedio = Math.round(stat.tempoMedio / stat.sessoes);
                stat.usuarios = stat.usuarios.size;
            }
        });

        // Estatísticas de origem do tráfego
        const trafficStats = {
            sources: {},
            mediums: {},
            campaigns: {}
        };

        data.forEach(session => {
            const source = session.trafficSource?.source || 'Direto';
            const medium = session.trafficSource?.medium || 'Direto';
            const campaign = session.trafficSource?.campaign || 'Nenhuma';

            if (!trafficStats.sources[source]) trafficStats.sources[source] = 0;
            if (!trafficStats.mediums[medium]) trafficStats.mediums[medium] = 0;
            if (!trafficStats.campaigns[campaign]) trafficStats.campaigns[campaign] = 0;

            trafficStats.sources[source]++;
            trafficStats.mediums[medium]++;
            trafficStats.campaigns[campaign]++;
        });

        // Estatísticas de dispositivos
        const deviceStats = {
            mobile: 0,
            desktop: 0,
            tablet: 0,
            browsers: {},
            os: {}
        };

        data.forEach(session => {
            if (session.sessionInfo?.browserInfo) {
                const { isMobile, isTablet, isDesktop, name: browser, os } = session.sessionInfo.browserInfo;
                
                if (isMobile) deviceStats.mobile++;
                else if (isTablet) deviceStats.tablet++;
                else if (isDesktop) deviceStats.desktop++;

                if (!deviceStats.browsers[browser]) deviceStats.browsers[browser] = 0;
                if (!deviceStats.os[os]) deviceStats.os[os] = 0;

                deviceStats.browsers[browser]++;
                deviceStats.os[os]++;
            }
        });

        res.json({
            viewStats,
            trends,
            paises: paisesStats,
            horasAtividade: horasStats,
            trafego: trafficStats,
            dispositivos: deviceStats
        });
    } catch (error) {
        console.error('Erro ao calcular estatísticas:', error);
        res.status(500).json({ error: 'Erro ao calcular estatísticas' });
    }
});

// Rota para a página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota para o dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Iniciar o servidor
app.listen(port, () => {
    console.log(`\n🚀 Servidor iniciado em http://localhost:${port}`);
});
