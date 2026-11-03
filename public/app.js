const form = document.getElementById('locomotive-form');
const serialConfigForm = document.getElementById('serial-config-form');
const serialPortSelect = document.getElementById('serialPortSelect');
const baudRateSelect = document.getElementById('baudRateSelect');
const speedInput = document.getElementById('speed');
const speedValue = document.getElementById('speedValue');
const responseBox = document.getElementById('responseBox');
const statusChip = document.getElementById('status-chip');
const stopButton = document.getElementById('stopButton');

const updateSliderValue = () => {
  speedValue.textContent = speedInput.value;
};

const updateStatus = (connected) => {
  statusChip.textContent = connected ? 'online' : 'offline';
  statusChip.classList.toggle('online', connected);
  statusChip.classList.toggle('offline', !connected);
};

const populateSerialPorts = (ports, currentPort) => {
  const options = [...new Set((ports || []).map((port) => port.path).filter(Boolean))];

  if (currentPort && !options.includes(currentPort)) {
    options.unshift(currentPort);
  }

  if (options.length === 0) {
    options.push('/dev/ttyUSB0');
  }

  serialPortSelect.innerHTML = options
    .map((port) => `<option value="${port}">${port}</option>`)
    .join('');

  serialPortSelect.value = currentPort || options[0];
};

const loadSerialConfig = async () => {
  try {
    const [portsResponse, statusResponse] = await Promise.all([
      fetch('/api/serial/ports'),
      fetch('/api/status')
    ]);

    const portsData = await portsResponse.json();
    const statusData = await statusResponse.json();
    const currentPort = (statusData.serial && statusData.serial.port) || '/dev/ttyUSB0';
    const currentBaud = String((statusData.serial && statusData.serial.baudRate) || 19200);

    populateSerialPorts(portsData.ports, currentPort);
    baudRateSelect.value = currentBaud;
    updateStatus(Boolean(statusData.serial && statusData.serial.connected));
  } catch (_error) {
    populateSerialPorts([], '/dev/ttyUSB0');
    baudRateSelect.value = '19200';
    updateStatus(false);
  }
};

const saveSerialConfig = async (event) => {
  event.preventDefault();

  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portName: serialPortSelect.value,
        baudRate: baudRateSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Unable to apply serial settings.');
    }

    responseBox.textContent = `Serial settings updated: ${serialPortSelect.value} @ ${baudRateSelect.value} baud.`;
    responseBox.classList.remove('error');
    updateStatus(Boolean(data.serial && data.serial.connected));
    await getStatus();
  } catch (error) {
    responseBox.textContent = error.message;
    responseBox.classList.add('error');
  }
};

const getStatus = async () => {
  try {
    const response = await fetch('/api/status');
    const data = await response.json();
    updateStatus(Boolean(data.serial && data.serial.connected));
  } catch (error) {
    updateStatus(false);
  }
};

speedInput.addEventListener('input', updateSliderValue);
updateSliderValue();
loadSerialConfig();
getStatus();

serialConfigForm.addEventListener('submit', saveSerialConfig);

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const decoderId = document.getElementById('decoderId').value;
  const direction = document.querySelector('input[name="direction"]:checked').value;
  const speed = Number(speedInput.value);

  responseBox.textContent = 'Sending command...';
  responseBox.classList.remove('error');

  try {
    const response = await fetch('/api/locomotive/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decoderId, speed, direction })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Command rejected by the server.');
    }

    responseBox.textContent = `Sent decoder ${decoderId} to ${direction} at speed ${speed}.`;
    updateStatus(Boolean(data.status && data.status.connected));
  } catch (error) {
    responseBox.textContent = error.message;
    responseBox.classList.add('error');
  }
});

stopButton.addEventListener('click', async () => {
  responseBox.textContent = 'Stopping locomotive...';
  responseBox.classList.remove('error');

  const decoderId = document.getElementById('decoderId').value;

  try {
    const response = await fetch('/api/locomotive/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decoderId, speed: 0, direction: document.querySelector('input[name="direction"]:checked').value, stop: true })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Stop command failed.');
    }

    speedInput.value = '0';
    updateSliderValue();
    responseBox.textContent = `Stopped decoder ${decoderId}.`;
  } catch (error) {
    responseBox.textContent = error.message;
    responseBox.classList.add('error');
  }
});

setInterval(getStatus, 5000);
