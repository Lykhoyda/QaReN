const GIB: u64 = 1024 * 1024 * 1024;
pub const HOST_RESERVE: u64 = 2 * GIB;
pub const LANE_HEADROOM: u64 = 4 * GIB;

pub struct Memory {
    pub free: u64,
    pub available: u64,
    pub compressed: Option<u64>,
    pub pressure: Option<bool>,
}

impl Memory {
    pub fn lanes(&self) -> u64 {
        self.available.saturating_sub(HOST_RESERVE) / LANE_HEADROOM
    }

    pub fn constrained(&self, booted: usize) -> bool {
        self.pressure == Some(true) || self.lanes() < booted.max(1) as u64
    }
}

pub struct Cpu {
    pub load: [f64; 3],
    pub cores: usize,
    pub idle: f64,
}

impl Cpu {
    pub fn constrained(&self) -> bool {
        self.load[0] >= self.cores as f64 || self.idle < 10.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headroom_reserves_the_host_before_budgeting_lanes() {
        let mut memory = Memory {
            free: 0,
            available: HOST_RESERVE - 1,
            compressed: None,
            pressure: Some(false),
        };
        assert_eq!(memory.lanes(), 0);
        assert!(memory.constrained(0));
        memory.available = HOST_RESERVE + LANE_HEADROOM;
        assert_eq!(memory.lanes(), 1);
        assert!(!memory.constrained(1));
        assert!(memory.constrained(2));
        memory.pressure = Some(true);
        assert!(memory.constrained(1));
    }

    #[test]
    fn load_or_low_idle_warns_at_the_documented_boundaries() {
        let mut cpu = Cpu {
            load: [7.99, 20.0, 20.0],
            cores: 8,
            idle: 10.0,
        };
        assert!(!cpu.constrained());
        cpu.load[0] = 8.0;
        assert!(cpu.constrained());
        cpu.load[0] = 0.0;
        cpu.idle = 9.99;
        assert!(cpu.constrained());
    }
}
