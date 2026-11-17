export {};
// The offscreen document and the floating window cannot show the browser's microphone prompt.
// This extension tab can: once allowed here, the whole extension may use the microphone.
const button = document.getElementById('allow') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;

const done = () => {
  button.disabled = true;
  button.textContent = 'Microfone permitido';
  status.className = 'ok';
  status.textContent = 'Pronto! Pode fechar esta aba e voltar a ligar.';
  void chrome.runtime.sendMessage({ type: 'microphone-permission-changed' }).catch(() => undefined);
  window.setTimeout(() => window.close(), 2500);
};

button.addEventListener('click', async () => {
  status.className = ''; status.textContent = 'Aguardando você clicar em "Permitir" no aviso do navegador…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    done();
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    status.className = 'bad';
    status.textContent = name === 'NotFoundError'
      ? 'Nenhum microfone encontrado. Conecte um fone com microfone e tente de novo.'
      : 'O microfone foi bloqueado. Clique no cadeado ao lado do endereço desta página, libere o "Microfone" e tente de novo.';
  }
});

void navigator.permissions.query({ name: 'microphone' as PermissionName }).then((result) => { if (result.state === 'granted') done(); }).catch(() => undefined);
