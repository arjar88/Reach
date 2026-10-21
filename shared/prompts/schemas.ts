import { z } from "zod";

export const onboardingSchema = z.object({
  company: z.object({
    description: z.string(),
    pain_points: z.array(z.string()),
    features: z.array(z.string()),
  }),
  icp: z.object({
    job_titles: z.array(z.string()),
    industries: z.array(z.string()),
    company_sizes: z.array(z.string()),
    locations: z.array(z.string()),
  }),
  keywords: z.array(z.string()).max(6),
  competitor_names: z.array(z.string()).max(5),
  influencer_names: z.array(z.string()).max(5),
});

export const prescoreSchema = z.object({
  results: z.array(z.object({ id: z.string(), keep: z.boolean() })),
});

export const scoreSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    score: z.number().min(0).max(1),
    reason: z.string().max(140),
  })),
});

export const writeSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
});

export const labelSchema = z.object({
  label: z.enum(["interested", "not_interested", "out_of_office", "other"]),
  reason: z.string(),
});

export const draftSchema = z.object({
  body: z.string(),
});

export type OnboardingOutput = z.infer<typeof onboardingSchema>;
export type PrescoreOutput = z.infer<typeof prescoreSchema>;
export type ScoreOutput = z.infer<typeof scoreSchema>;
export type WriteOutput = z.infer<typeof writeSchema>;
export type LabelOutput = z.infer<typeof labelSchema>;
export type DraftOutput = z.infer<typeof draftSchema>;
