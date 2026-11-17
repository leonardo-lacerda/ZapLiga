// Object URLs para prévias e prints. O jsdom (testes) não implementa createObjectURL.
export const createObjectUrl = (blob: Blob) => (typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '');
export const revokeObjectUrl = (url: string) => { if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url); };
