// GENERATED from .claude/skills/voice-gender/priors.json — do not edit by hand.
// Regenerate:  python3 web/build_priors.py
export const PRIORS = {
  "model_id": "vgender-priors-v1.1",
  "combination": {
    "gain_k": 2.0,
    "llr_clamp": 6.0
  },
  "features": {
    "f0_mean_log": {
      "tier": 1,
      "group": "pitch",
      "weight": 0.27,
      "unit": "ln(Hz)",
      "female": {
        "mu": 5.352,
        "sd": 0.165
      },
      "male": {
        "mu": 4.787,
        "sd": 0.175
      },
      "d_prime": 3.32
    },
    "f0_p5_log": {
      "tier": 1,
      "group": "pitch",
      "weight": 0.07,
      "unit": "ln(Hz)",
      "female": {
        "mu": 5.075,
        "sd": 0.19
      },
      "male": {
        "mu": 4.477,
        "sd": 0.2
      },
      "d_prime": 3.07
    },
    "vtl_estimate": {
      "tier": 1,
      "group": "resonance",
      "weight": 0.2,
      "unit": "cm",
      "female": {
        "mu": 14.7,
        "sd": 0.8
      },
      "male": {
        "mu": 17.2,
        "sd": 0.9
      },
      "d_prime": 2.94
    },
    "f3": {
      "tier": 1,
      "group": "resonance",
      "weight": 0.12,
      "unit": "Hz",
      "female": {
        "mu": 2980,
        "sd": 240
      },
      "male": {
        "mu": 2540,
        "sd": 210
      },
      "d_prime": 1.95
    },
    "f4": {
      "tier": 1,
      "group": "resonance",
      "weight": 0.08,
      "unit": "Hz",
      "female": {
        "mu": 4020,
        "sd": 310
      },
      "male": {
        "mu": 3450,
        "sd": 280
      },
      "d_prime": 1.93
    },
    "f1": {
      "tier": 1,
      "group": "resonance",
      "weight": 0.03,
      "unit": "Hz",
      "female": {
        "mu": 590,
        "sd": 105
      },
      "male": {
        "mu": 500,
        "sd": 90
      },
      "d_prime": 0.92
    },
    "f2": {
      "tier": 1,
      "group": "resonance",
      "weight": 0.03,
      "unit": "Hz",
      "female": {
        "mu": 1720,
        "sd": 230
      },
      "male": {
        "mu": 1500,
        "sd": 200
      },
      "d_prime": 1.02
    },
    "h1_h2": {
      "tier": 2,
      "group": "quality",
      "weight": 0.08,
      "unit": "dB",
      "female": {
        "mu": 5.5,
        "sd": 3.5
      },
      "male": {
        "mu": 1.5,
        "sd": 3.0
      },
      "d_prime": 1.23
    },
    "hnr": {
      "tier": 2,
      "group": "quality",
      "weight": 0.04,
      "unit": "dB",
      "female": {
        "mu": 16.5,
        "sd": 4.2
      },
      "male": {
        "mu": 19.0,
        "sd": 4.0
      },
      "d_prime": 0.61
    },
    "jitter_local": {
      "tier": 2,
      "group": "quality",
      "weight": 0.015,
      "unit": "percent",
      "female": {
        "mu": 0.52,
        "sd": 0.28
      },
      "male": {
        "mu": 0.62,
        "sd": 0.3
      },
      "d_prime": 0.34
    },
    "shimmer_local": {
      "tier": 2,
      "group": "quality",
      "weight": 0.015,
      "unit": "percent",
      "female": {
        "mu": 3.1,
        "sd": 1.3
      },
      "male": {
        "mu": 3.6,
        "sd": 1.4
      },
      "d_prime": 0.37
    },
    "spectral_centroid": {
      "tier": 3,
      "group": "spectral",
      "weight": 0.03,
      "unit": "Hz",
      "female": {
        "mu": 1750,
        "sd": 400
      },
      "male": {
        "mu": 1450,
        "sd": 350
      },
      "d_prime": 0.8
    },
    "spectral_rolloff85": {
      "tier": 3,
      "group": "spectral",
      "weight": 0.02,
      "unit": "Hz",
      "female": {
        "mu": 3450,
        "sd": 780
      },
      "male": {
        "mu": 2950,
        "sd": 700
      },
      "d_prime": 0.67
    }
  }
};
