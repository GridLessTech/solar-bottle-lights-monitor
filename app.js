        const LOGIN_CONFIG = { user: 'admin', pass: 'admin' };
        const MQTT_OPTIONS = {
            username: 'roche',
            password: 'roche@54321',
            reconnectPeriod: 1000,
            connectTimeout: 30 * 1000,
        };
        const MQTT_URL = 'wss://mqtt-racknerd.imbento.online:9001';
        const TOPICS = {
            status: '/ctu/electric-monitor/status',
            telemetry: '/ctu/electric-monitor/telemetry',
            relayCommand: (id) => `/ctu/electric-monitor/relay/${id}/set`,
            relayState: (id) => `/ctu/electric-monitor/relay/${id}/state`,
        };
        const metricDefinitions = {
            voltage: { selector: '#voltage-gauge', color: '#60A5FA', unit: 'V', max: 5, decimals: 2 },
            current: { selector: '#current-gauge', color: '#C084FC', unit: 'A', max: 3, decimals: 3 },
            power: { selector: '#power-gauge', color: '#818CF8', unit: 'W', max: 15, decimals: 3 },
            energy: { selector: '#energy-gauge', color: '#FACC15', unit: 'Wh', max: 50, decimals: 4 },
            load: { selector: '#load-gauge', color: '#F472B6', unit: 'V', max: 5, decimals: 2 },
            shunt: { selector: '#shunt-gauge', color: '#FB923C', unit: 'mV', max: 150, decimals: 2 },
        };

        const lightsState = { 1: false, 2: false, 3: false, 4: false };
        let client = null;
        let deviceTimeoutTimer = null;
        let mqttStarted = false;
        let metricChartsInitialized = false;
        let deviceOnline = false;
        let offlineToastTimer = null;
        const metricCharts = {};
        const metricDisplays = {};

        const loginForm = document.getElementById('login-form');
        const loginScreen = document.getElementById('login-screen');
        const dashboard = document.getElementById('dashboard');
        const pageShell = document.getElementById('page-shell');
        const consoleLog = document.getElementById('console-log');
        const logBody = document.getElementById('log-body');
        const bannerLabel = document.getElementById('banner-label');
        const bannerDot = document.getElementById('banner-dot');
        const hostStatusText = document.getElementById('host-status-text');
        const hostStatusDot = document.getElementById('host-status-dot');
        const deviceStatusText = document.getElementById('device-status-text');
        const deviceStatusDot = document.getElementById('device-status-dot');
        const deviceStatusMeta = document.getElementById('device-status-meta');
        const offlineToast = document.getElementById('offline-toast');
        const offlineToastMessage = document.getElementById('offline-toast-message');

        loginForm.onsubmit = (e) => {
            e.preventDefault();
            const u = document.getElementById('username').value;
            const p = document.getElementById('password').value;
            if (u === LOGIN_CONFIG.user && p === LOGIN_CONFIG.pass) {
                loginScreen.classList.add('hidden');
                dashboard.classList.remove('hidden');
                pageShell.classList.add('dashboard-active');
                initMonitor();
            } else {
                document.getElementById('login-error').classList.remove('hidden');
            }
        };

        function handleLogout() {
            if (client) {
                client.end(true);
            }
            window.location.reload();
        }

        function initMonitor() {
            if (mqttStarted) {
                return;
            }
            mqttStarted = true;
            initMetricCharts();
            updateClock();
            setInterval(updateClock, 1000);
            updateBatteryUI(0);
            connectMqtt();
            addLogEntry('System', 'Dashboard initialized', 'READY');
        }

        function updateClock() {
            document.getElementById('clock').innerText = new Date().toLocaleTimeString();
        }

        function connectMqtt() {
            logMessage(`Connecting to broker ${MQTT_URL}`);
            setHostConnectionState('connecting');
            client = mqtt.connect(MQTT_URL, MQTT_OPTIONS);

            client.on('connect', () => {
                logMessage('Connected to MQTT broker');
                setHostConnectionState('connected');
                client.subscribe(TOPICS.status);
                client.subscribe(TOPICS.telemetry);
                for (let id = 1; id <= 4; id++) {
                    client.subscribe(TOPICS.relayState(id));
                }
                addLogEntry('MQTT', 'Broker connection established', 'ONLINE');
            });

            client.on('reconnect', () => {
                logMessage('Reconnecting to MQTT broker...');
                setHostConnectionState('connecting');
            });

            client.on('close', () => {
                logMessage('MQTT connection closed');
                setHostConnectionState('disconnected');
                setDeviceOffline('Lost broker connection');
            });

            client.on('offline', () => {
                logMessage('MQTT client offline');
                setHostConnectionState('disconnected');
            });

            client.on('error', (err) => {
                logMessage(`MQTT error: ${err.message}`);
            });

            client.on('message', (topic, message) => {
                const value = message.toString();
                logMessage(`RX ${topic}: ${value}`);

                if (topic === TOPICS.status) {
                    if (value.startsWith('online')) {
                        setDeviceOnline(value);
                        resetDeviceTimeout();
                    } else {
                        setDeviceOffline('Status topic reported offline');
                    }
                    return;
                }

                if (topic === TOPICS.telemetry) {
                    try {
                        const data = JSON.parse(value);
                        updateTelemetry(data);
                        resetDeviceTimeout();
                    } catch (error) {
                        logMessage(`Telemetry parse error: ${error.message}`);
                    }
                    return;
                }

                for (let id = 1; id <= 4; id++) {
                    if (topic === TOPICS.relayState(id)) {
                        updateRelayButton(id, value === '1');
                        addLogEntry(`Relay ${id}`, value === '1' ? 'Turned ON' : 'Turned OFF', value === '1' ? 'ACTIVE' : 'IDLE');
                        return;
                    }
                }
            });
        }

        function setHostConnectionState(state) {
            if (state === 'connected') {
                bannerLabel.textContent = 'Connected to MQTT host';
                bannerLabel.className = 'text-sm font-semibold text-emerald-400';
                hostStatusText.textContent = 'Connected';
                hostStatusText.className = 'text-sm font-semibold text-emerald-400';
                bannerDot.className = 'status-dot dot-online';
                hostStatusDot.className = 'status-dot dot-online';
            } else if (state === 'connecting') {
                bannerLabel.textContent = 'Connecting to host...';
                bannerLabel.className = 'text-sm font-semibold text-amber-400';
                hostStatusText.textContent = 'Connecting';
                hostStatusText.className = 'text-sm font-semibold text-amber-400';
                bannerDot.className = 'status-dot dot-warning';
                hostStatusDot.className = 'status-dot dot-warning';
            } else {
                bannerLabel.textContent = 'Disconnected from host';
                bannerLabel.className = 'text-sm font-semibold text-red-400';
                hostStatusText.textContent = 'Disconnected';
                hostStatusText.className = 'text-sm font-semibold text-red-400';
                bannerDot.className = 'status-dot dot-offline';
                hostStatusDot.className = 'status-dot dot-offline';
            }
        }

        function setDeviceOnline(message) {
            deviceOnline = true;
            deviceStatusText.textContent = 'Online';
            deviceStatusText.className = 'text-sm font-semibold text-emerald-400';
            deviceStatusDot.className = 'status-dot dot-online';
            deviceStatusMeta.textContent = `Heartbeat ${message.replace('online @ ', 'at ')}`;
        }

        function setDeviceOffline(reason = 'Waiting for heartbeat') {
            deviceOnline = false;
            deviceStatusText.textContent = 'Offline';
            deviceStatusText.className = 'text-sm font-semibold text-red-400';
            deviceStatusDot.className = 'status-dot dot-offline';
            deviceStatusMeta.textContent = reason;
        }

        function showOfflineToast(message) {
            offlineToastMessage.textContent = message;
            offlineToast.classList.add('show');
            if (offlineToastTimer) {
                clearTimeout(offlineToastTimer);
            }
            offlineToastTimer = setTimeout(() => {
                offlineToast.classList.remove('show');
            }, 2600);
        }

        function resetDeviceTimeout() {
            if (deviceTimeoutTimer) {
                clearTimeout(deviceTimeoutTimer);
            }
            deviceTimeoutTimer = setTimeout(() => {
                logMessage('Device heartbeat timeout');
                setDeviceOffline('No heartbeat received');
            }, 8000);
        }

        function initMetricCharts() {
            if (metricChartsInitialized) {
                return;
            }

            Object.entries(metricDefinitions).forEach(([key, config]) => {
                metricDisplays[key] = `-- ${config.unit}`;
                const chart = new ApexCharts(document.querySelector(config.selector), {
                    chart: {
                        type: 'radialBar',
                        height: 170,
                        sparkline: { enabled: true },
                        toolbar: { show: false },
                        animations: {
                            enabled: true,
                            easing: 'easeinout',
                            speed: 550,
                        },
                    },
                    series: [0],
                    colors: [config.color],
                    stroke: {
                        lineCap: 'round',
                    },
                    plotOptions: {
                        radialBar: {
                            startAngle: -130,
                            endAngle: 130,
                            hollow: {
                                size: '58%',
                                background: 'rgba(15, 23, 42, 0.92)',
                            },
                            track: {
                                background: 'rgba(226, 232, 240, 0.14)',
                                strokeWidth: '100%',
                                margin: 2,
                            },
                            dataLabels: {
                                name: {
                                    show: true,
                                    offsetY: 38,
                                    color: '#64748B',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                },
                                value: {
                                    offsetY: -6,
                                    color: '#F8FAFC',
                                    fontSize: '26px',
                                    fontWeight: 700,
                                    formatter: function() {
                                        return metricDisplays[key];
                                    },
                                },
                            },
                        },
                    },
                    labels: [config.unit],
                    grid: {
                        padding: {
                            top: -12,
                            bottom: -22,
                        },
                    },
                    tooltip: {
                        enabled: false,
                    },
                });
                chart.render();
                metricCharts[key] = chart;
            });

            metricChartsInitialized = true;
        }

        function updateMetricGauge(key, rawValue) {
            const config = metricDefinitions[key];
            if (!config || !metricCharts[key]) {
                return;
            }

            const safeValue = Number.isFinite(rawValue) ? rawValue : 0;
            const percent = Math.max(0, Math.min(100, (safeValue / config.max) * 100));
            metricDisplays[key] = `${safeValue.toFixed(config.decimals)} ${config.unit}`;
            metricCharts[key].updateSeries([percent]);
        }

        function updateBatteryUI(percent) {
            const container = document.getElementById('battery-container');
            const bars = container.children;
            const label = document.getElementById('charge-percent');
            let textClass = 'text-emerald-400';
            if (percent < 20) textClass = 'text-red-400';
            else if (percent < 50) textClass = 'text-yellow-400';
            label.className = `${textClass} font-bold text-sm transition-colors duration-500`;
            label.innerText = `${percent}%`;
            const activeBarsCount = Math.max(0, Math.ceil(percent / 10));
            for (let i = 0; i < bars.length; i++) {
                if (i < activeBarsCount) {
                    const barColor = i < 2 ? 'bg-red-500' : (i < 5 ? 'bg-yellow-500' : 'bg-emerald-500');
                    bars[i].className = `h-full flex-1 rounded-sm transition-all duration-500 ${barColor} shadow-[0_0_8px_rgba(0,0,0,0.3)]`;
                } else {
                    bars[i].className = 'h-full flex-1 rounded-sm bg-slate-800 transition-all duration-500';
                }
            }
        }

        function updateTelemetry(data) {
            const busVoltage = Number(data.busVoltage ?? 0);
            const currentA = Number(data.currentA ?? 0);
            const powerW = Number(data.powerW ?? 0);
            const energyWh = Number(data.energyWh ?? 0);
            const batteryPercent = Math.round(Number(data.batteryPercent ?? 0));
            const shuntVoltage = Number(data.shuntVoltage ?? 0);
            const loadVoltage = Number(data.loadVoltage ?? 0);
            const usedMah = (energyWh * 1000) / 3.7;

            document.getElementById('mah-label').innerText = `${Math.round(usedMah)} mAh estimated used`;
            document.getElementById('time-rem-status').innerText = `Seq ${data.seq ?? '--'} telemetry packet`;
            document.getElementById('temp-status').innerText = 'INA219 shunt voltage';
            document.getElementById('volt-label').innerText = 'INA219 bus voltage';
            document.getElementById('current-label').innerText = 'Current flowing through shunt';
            updateMetricGauge('voltage', busVoltage);
            updateMetricGauge('current', currentA);
            updateMetricGauge('power', powerW);
            updateMetricGauge('energy', energyWh);
            updateMetricGauge('load', loadVoltage);
            updateMetricGauge('shunt', shuntVoltage);
            updateBatteryUI(batteryPercent);

            addLogEntry('Telemetry', `${busVoltage.toFixed(2)}V / ${currentA.toFixed(3)}A / ${powerW.toFixed(3)}W`, 'SYNC');
        }

        function updateRelayButton(id, isOn) {
            lightsState[id] = isOn;
            const btn = document.getElementById(`light-${id}`);
            const bulb = btn.querySelector('.relay-bulb');
            const status = btn.querySelector('.light-status');
            if (isOn) {
                btn.classList.add('is-on');
                btn.classList.add('border-emerald-400/30');
                btn.classList.remove('border-slate-700');
                status.textContent = 'On';
                status.className = 'light-status text-[10px] text-emerald-300 uppercase tracking-[0.18em] mt-1';
                bulb.classList.remove('text-slate-500');
            } else {
                btn.classList.remove('is-on');
                btn.classList.remove('border-emerald-400/30');
                btn.classList.add('border-slate-700');
                status.textContent = 'Off';
                status.className = 'light-status text-[10px] text-slate-500 uppercase tracking-[0.18em] mt-1';
                bulb.classList.add('text-slate-500');
            }
        }

        function toggleLight(id) {
            if (!client || !client.connected) {
                const message = 'The relay command cannot be sent because the MQTT host is disconnected.';
                logMessage(`Cannot send relay ${id} command while MQTT is disconnected`);
                showOfflineToast(message);
                return;
            }
            if (!deviceOnline) {
                const message = `Light ${id} cannot be switched because the device is offline.`;
                logMessage(`Cannot send relay ${id} command because device is offline`);
                showOfflineToast(message);
                return;
            }
            const nextState = !lightsState[id];
            client.publish(TOPICS.relayCommand(id), nextState ? '1' : '0');
            addLogEntry(`Relay ${id}`, nextState ? 'Command ON sent' : 'Command OFF sent', 'TX');
            logMessage(`TX ${TOPICS.relayCommand(id)}: ${nextState ? '1' : '0'}`);
        }

        function addLogEntry(event, value, status) {
            const tr = document.createElement('tr');
            const statusTone = status === 'ONLINE' || status === 'SYNC' || status === 'ACTIVE'
                ? 'bg-emerald-500/10 text-emerald-500'
                : status === 'TX' || status === 'READY'
                    ? 'bg-amber-500/10 text-amber-400'
                    : 'bg-slate-700/40 text-slate-300';
            tr.innerHTML = `<td class="px-6 py-4 font-medium italic">${event}</td><td class="px-6 py-4 font-mono text-emerald-400">${value}</td><td class="px-6 py-4 text-slate-500">${new Date().toLocaleTimeString()}</td><td class="px-6 py-4 text-right"><span class="${statusTone} text-[9px] px-2 py-1 rounded font-black">${status}</span></td>`;
            logBody.prepend(tr);
            if (logBody.children.length > 8) {
                logBody.lastChild.remove();
            }
        }

        function logMessage(msg) {
            const timestamp = new Date().toLocaleTimeString();
            consoleLog.value += `[${timestamp}] ${msg}\n`;
            consoleLog.scrollTop = consoleLog.scrollHeight;
        }

        window.onload = () => {
            updateBatteryUI(0);
            setHostConnectionState('disconnected');
            setDeviceOffline();
            for (let id = 1; id <= 4; id++) {
                updateRelayButton(id, false);
            }
        };
