import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal } from '@cardo/ui';
import { supportedLanguages } from '@cardo/i18n';
import { useAppStore, type Profile } from '../state/appStore';

/**
 * Local profile – no account, nothing leaves the device (and the modal
 * says so). Name is required; everything else is optional.
 */
export function ProfileModal({
  onDone,
  initial,
}: {
  onDone(): void;
  initial?: Profile | null;
}) {
  const { t, i18n } = useTranslation();
  const saveProfile = useAppStore((s) => s.saveProfile);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [birthday, setBirthday] = useState(initial?.birthday ?? '');
  const [country, setCountry] = useState(initial?.country ?? '');
  const [touched, setTouched] = useState(false);

  const valid = name.trim().length > 0;

  async function submit() {
    setTouched(true);
    if (!valid) return;
    await saveProfile({
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(birthday ? { birthday } : {}),
      ...(country.trim() ? { country: country.trim() } : {}),
    });
    onDone();
  }

  return (
    <Modal onClose={() => (initial ? onDone() : undefined)}>
      <div className="profile">
        <h3>{t('profile.title')}</h3>
        <p className="c-muted">{t('profile.localNote')}</p>

        <label className="profile__row">
          <span>
            {t('profile.name')} <span className="profile__required">*</span>
          </span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          {touched && !valid && <span className="profile__error">{t('profile.nameRequired')}</span>}
        </label>

        <label className="profile__row">
          <span>{t('profile.email')}</span>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label className="profile__row">
          <span>{t('profile.birthday')}</span>
          <Input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </label>

        <label className="profile__row">
          <span>{t('profile.country')}</span>
          <Input value={country} onChange={(e) => setCountry(e.target.value)} />
        </label>

        <label className="profile__row">
          <span>{t('settings.language')}</span>
          <select
            className="c-input"
            value={i18n.language}
            onChange={(e) => void setLanguage(e.target.value)}
          >
            {supportedLanguages.map((lang) => (
              <option key={lang} value={lang}>
                {lang === 'en' ? 'English' : 'Deutsch'}
              </option>
            ))}
          </select>
        </label>

        <div className="profile__actions">
          <Button variant="primary" onClick={() => void submit()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
