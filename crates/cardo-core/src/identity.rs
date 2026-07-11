use serde::Serialize;

/// Identity abstraction. Today: key-based (no account). Later an
/// `AccountIdentity` implementation slots in – no tool ever notices.
pub trait IdentityProvider: Send + Sync {
    fn get_identity(&self) -> Identity;
    fn is_sync_authorized(&self) -> bool;
    fn get_sync_credentials(&self) -> Option<SyncCredentials>;
}

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub device_id: String,
}

#[derive(Debug, Clone)]
pub struct SyncCredentials {
    /// HKDF-derived auth token (goes to the server). The data key NEVER
    /// leaves the crypto layer (end-to-end encryption).
    pub auth_token: String,
    pub license_id: String,
}

/// MVP implementation: no key present, sync never authorized.
/// Release 1.1/1.2 fills this with real Ed25519 key verification.
pub struct LicenseKeyIdentity {
    device_id: String,
}

impl LicenseKeyIdentity {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self { device_id: device_id.into() }
    }
}

impl IdentityProvider for LicenseKeyIdentity {
    fn get_identity(&self) -> Identity {
        Identity { device_id: self.device_id.clone() }
    }

    fn is_sync_authorized(&self) -> bool {
        false
    }

    fn get_sync_credentials(&self) -> Option<SyncCredentials> {
        None
    }
}
