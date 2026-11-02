const form = document.getElementById('locomotive-form');
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
getStatus();

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
