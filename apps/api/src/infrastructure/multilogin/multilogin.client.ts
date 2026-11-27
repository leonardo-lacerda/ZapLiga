import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** A Multilogin cloud phone, reduced to what a line's device profile copies from it. */
export type MultiloginPhone = {
  id: string;
  name: string;
  /** "16" for an "Android 16" phone. */
  androidVersion: string;
  brand: string;
  model: string;
  /** Whether the phone has a SIM: one without a carrier logs in with mcc/mnc "000". */
  hasSim: boolean;
};

/** One entry of `GET /mobile_profiles/phone/list`, as Multilogin answers it (checked 2026-11-27). */
export type MultiloginRawPhone = {
  id: string;
  serial_name: string;
  equipment_info: { device_brand?: string; device_model?: string; os_version?: string; enable_sim?: number };
};

type PhonePage = { data: { items: MultiloginRawPhone[]; total: number } };

const BASE_URL = 'https://api.multilogin.com';
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;

export const MULTILOGIN_UNAVAILABLE_MESSAGE = 'A Multilogin não respondeu. Tente novamente em instantes.';
export const MULTILOGIN_TOKEN_MESSAGE = 'A Multilogin recusou o token da API. Verifique MULTILOGIN_TOKEN.';

/**
 * The phone's brand, model and Android version ("Android 16") come from `equipment_info`. A phone
 * without them cannot give a line its identity, so it is left out rather than filled in.
 */
export function mapMultiloginPhone(raw: MultiloginRawPhone): MultiloginPhone | null {
  const equipment = raw.equipment_info;
  const androidVersion = /(\d{1,2})/.exec(equipment.os_version ?? '')?.[1];
  const brand = equipment.device_brand?.trim();
  const model = equipment.device_model?.trim();
  if (!androidVersion || !brand || !model) return null;
  return { id: raw.id, name: raw.serial_name, androidVersion, brand, model, hasSim: equipment.enable_sim === 1 };
}

/** The cloud phones of the Multilogin workspace whose token is `MULTILOGIN_TOKEN`. */
@Injectable()
export class MultiloginClient {
  private get token() {
    const token = process.env.MULTILOGIN_TOKEN?.trim();
    if (!token) throw new HttpException('MULTILOGIN_TOKEN não está configurado na API.', HttpStatus.SERVICE_UNAVAILABLE);
    return token;
  }

  async listPhones(): Promise<MultiloginPhone[]> {
    const phones: MultiloginPhone[] = [];
    for (let page = 1, seen = 0; ; page += 1) {
      const { items, total } = (await this.page(page)).data;
      for (const item of items) {
        const phone = mapMultiloginPhone(item);
        if (phone) phones.push(phone);
      }
      seen += items.length;
      if (items.length === 0 || seen >= total) return phones;
    }
  }

  async getPhone(id: string): Promise<MultiloginPhone | null> {
    return (await this.listPhones()).find((phone) => phone.id === id) ?? null;
  }

  private async page(page: number): Promise<PhonePage> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/mobile_profiles/phone/list?page=${page}&page_size=${PAGE_SIZE}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HttpException(MULTILOGIN_UNAVAILABLE_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (response.status === 401 || response.status === 403) throw new HttpException(MULTILOGIN_TOKEN_MESSAGE, HttpStatus.BAD_GATEWAY);
    if (!response.ok) throw new HttpException(MULTILOGIN_UNAVAILABLE_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
    return await response.json() as PhonePage;
  }
}
