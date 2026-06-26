import type { AppLanguage } from '../../shared/bridgegit';
import { cs } from './locales/cs';
import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { pl } from './locales/pl';
import { pt } from './locales/pt';
import { uk } from './locales/uk';
import { zh } from './locales/zh';
import type { TranslationMap } from './locales/types';

export interface AppLanguageOption {
  value: AppLanguage;
  label: string;
  copy: string;
}

export const APP_LANGUAGE_OPTIONS: AppLanguageOption[] = [
  { value: 'en', label: 'English', copy: 'Default app language and the baseline for new interface text.' },
  { value: 'cs', label: 'Čeština', copy: 'České rozhraní pro lokální workflow v BridgeGitu.' },
  { value: 'es', label: 'Español', copy: 'Spanish interface for a broad global audience.' },
  { value: 'de', label: 'Deutsch', copy: 'German interface for Central European teams.' },
  { value: 'fr', label: 'Français', copy: 'French interface for European and global users.' },
  { value: 'pt', label: 'Português', copy: 'Portuguese interface for Brazil and Portugal.' },
  { value: 'pl', label: 'Polski', copy: 'Polish interface for nearby developer teams.' },
  { value: 'uk', label: 'Українська', copy: 'Ukrainian interface without adding Russian.' },
  { value: 'zh', label: '中文', copy: 'Chinese interface for one of the largest developer audiences.' },
  { value: 'ja', label: '日本語', copy: 'Japanese interface for mature developer tooling markets.' },
  { value: 'ko', label: '한국어', copy: 'Korean interface for another strong developer tooling market.' },
];

const translations: Partial<Record<AppLanguage, TranslationMap>> = {
  en,
  cs,
  es,
  de,
  fr,
  pt,
  pl,
  uk,
  zh,
  ja,
  ko,
};

export function t(language: AppLanguage, key: string, params?: Record<string, string | number>): string {
  const value = translations[language]?.[key] ?? en[key] ?? key;
  return typeof value === 'function' ? value(params) : value;
}
