import { useState } from 'react'
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import type { AccrualTier, PolicyConfig } from '../lib/types'
import { formatHolidayRule } from '../lib/holidays'

type Props = {
  policy: PolicyConfig
  onChange: (policy: PolicyConfig) => void
}

export function PolicyEditor({ policy, onChange }: Props) {
  const [showHolidays, setShowHolidays] = useState(false)

  const updateTier = (index: number, updates: Partial<AccrualTier>) => {
    const newTiers = [...policy.accrualTiers]
    newTiers[index] = { ...newTiers[index], ...updates }
    onChange({ ...policy, accrualTiers: newTiers })
  }

  const addTier = () => {
    const lastTier = policy.accrualTiers[policy.accrualTiers.length - 1]
    const newMin = lastTier.maxYears ?? lastTier.minYears + 5
    // Move last tier's maxYears up
    const updatedTiers = [...policy.accrualTiers]
    updatedTiers[updatedTiers.length - 1] = { ...lastTier, maxYears: newMin }
    updatedTiers.push({
      minYears: newMin,
      maxYears: null,
      hoursPerPayPeriod: lastTier.hoursPerPayPeriod,
      label: `${newMin}+ Years`,
    })
    onChange({ ...policy, accrualTiers: updatedTiers })
  }

  const removeTier = (index: number) => {
    if (policy.accrualTiers.length <= 1) return
    const newTiers = policy.accrualTiers.filter((_, i) => i !== index)
    // Ensure last tier has no upper bound
    newTiers[newTiers.length - 1] = {
      ...newTiers[newTiers.length - 1],
      maxYears: null,
    }
    onChange({ ...policy, accrualTiers: newTiers })
  }

  const addHoliday = () => {
    onChange({
      ...policy,
      holidays: [
        ...policy.holidays,
        {
          type: 'fixed',
          month: 1,
          day: 1,
          name: 'New Holiday',
          weekendObservance: 'nearest_weekday',
        },
      ],
    })
  }

  const removeHoliday = (index: number) => {
    onChange({
      ...policy,
      holidays: policy.holidays.filter((_, i) => i !== index),
    })
  }

  return (
    <div className="space-y-6">
      {/* Accrual Tiers */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Accrual Tiers
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Set the vacation hours earned per pay period for each tier of service.
          Adjust these to match your employer's accrual schedule.
        </p>
        <div className="space-y-2">
          {policy.accrualTiers.map((tier, i) => (
            <div
              key={i}
              className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg"
            >
              <div className="flex-1 grid grid-cols-4 gap-2 items-center">
                <input
                  type="text"
                  value={tier.label}
                  onChange={(e) => updateTier(i, { label: e.target.value })}
                  className="px-2 py-1 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  aria-label={`Tier ${i + 1} label`}
                />
                <div className="flex items-center gap-1 text-xs">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={tier.minYears}
                    onChange={(e) =>
                      updateTier(i, { minYears: Number(e.target.value) })
                    }
                    className="w-12 px-1 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                    aria-label={`Tier ${i + 1} min years`}
                  />
                  <span className="text-gray-400">-</span>
                  {tier.maxYears !== null ? (
                    <input
                      type="number"
                      min={tier.minYears + 1}
                      step="1"
                      value={tier.maxYears}
                      onChange={(e) =>
                        updateTier(i, { maxYears: Number(e.target.value) })
                      }
                      className="w-12 px-1 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                      aria-label={`Tier ${i + 1} max years`}
                    />
                  ) : (
                    <span className="text-gray-400 text-xs">No limit</span>
                  )}
                  <span className="text-gray-400 text-xs">yrs</span>
                </div>
                <div className="flex items-center gap-1 text-xs">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={tier.hoursPerPayPeriod}
                    onChange={(e) =>
                      updateTier(i, {
                        hoursPerPayPeriod: Number(e.target.value),
                      })
                    }
                    className="w-16 px-1 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                    aria-label={`Tier ${i + 1} hours per pay period`}
                  />
                  <span className="text-gray-400">hrs/pp</span>
                </div>
                <div className="flex justify-end">
                  {policy.accrualTiers.length > 1 && (
                    <button
                      onClick={() => removeTier(i)}
                      className="p-1 text-gray-400 hover:text-red-500 transition-colors duration-150"
                      aria-label={`Remove tier ${i + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={addTier}
          className="mt-2 flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400 transition-colors duration-150"
        >
          <Plus className="w-3.5 h-3.5" /> Add tier
        </button>
      </div>

      {/* Pay Period & Work Schedule */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Pay Period & Schedule
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Pay period length (days)
            </label>
            <input
              type="number"
              min="1"
              max="31"
              value={policy.payPeriodLengthDays}
              onChange={(e) =>
                onChange({
                  ...policy,
                  payPeriodLengthDays: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Hours per work day
            </label>
            <input
              type="number"
              min="1"
              max="24"
              step="0.5"
              value={policy.hoursPerWorkDay}
              onChange={(e) =>
                onChange({
                  ...policy,
                  hoursPerWorkDay: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Work days
          </label>
          <div className="flex gap-1">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
              <button
                key={day}
                onClick={() => {
                  const workDays = policy.workDaysPerWeek.includes(i)
                    ? policy.workDaysPerWeek.filter((d) => d !== i)
                    : [...policy.workDaysPerWeek, i].sort()
                  onChange({ ...policy, workDaysPerWeek: workDays })
                }}
                className={`px-2 py-1 text-xs rounded ${
                  policy.workDaysPerWeek.includes(i)
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                } transition-colors duration-150`}
                aria-label={`${day} ${policy.workDaysPerWeek.includes(i) ? 'enabled' : 'disabled'}`}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Carryover */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Carryover Policy
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Cap strategy
            </label>
            <select
              value={policy.carryoverCapStrategy}
              onChange={(e) =>
                onChange({
                  ...policy,
                  carryoverCapStrategy: e.target.value as PolicyConfig['carryoverCapStrategy'],
                })
              }
              className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="annual_accrual">Annual accrual (current tier)</option>
              <option value="fixed_hours">Fixed hours</option>
              <option value="unlimited">Unlimited</option>
            </select>
          </div>
          {policy.carryoverCapStrategy === 'fixed_hours' && (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Fixed cap (hours)
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={policy.carryoverFixedCap ?? 0}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    carryoverFixedCap: Number(e.target.value),
                  })
                }
                className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Payout month
              </label>
              <select
                value={policy.carryoverPayoutDate.month}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    carryoverPayoutDate: {
                      ...policy.carryoverPayoutDate,
                      month: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {new Date(2000, i).toLocaleString('en', { month: 'long' })}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Payout day
              </label>
              <input
                type="number"
                min="1"
                max="31"
                value={policy.carryoverPayoutDate.day}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    carryoverPayoutDate: {
                      ...policy.carryoverPayoutDate,
                      day: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Sick Leave */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Sick Leave
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Annual grant (hours)
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={policy.sickLeaveAnnualGrant}
              onChange={(e) =>
                onChange({
                  ...policy,
                  sickLeaveAnnualGrant: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Max balance (hours)
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={policy.sickLeaveMaxBalance}
              onChange={(e) =>
                onChange({
                  ...policy,
                  sickLeaveMaxBalance: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Bank Hours Payout */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Bank Hours Payout Window
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Bank hours are paid out during this window. Outside this period, they can be used for time off.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Payout starts (month/day)
            </label>
            <div className="flex gap-1">
              <select
                value={policy.bankHoursPayoutStart.month}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    bankHoursPayoutStart: {
                      ...policy.bankHoursPayoutStart,
                      month: Number(e.target.value),
                    },
                  })
                }
                className="flex-1 px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {new Date(2000, i).toLocaleString('en', { month: 'short' })}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                max="31"
                value={policy.bankHoursPayoutStart.day}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    bankHoursPayoutStart: {
                      ...policy.bankHoursPayoutStart,
                      day: Number(e.target.value),
                    },
                  })
                }
                className="w-14 px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Payout ends (month/day)
            </label>
            <div className="flex gap-1">
              <select
                value={policy.bankHoursPayoutEnd.month}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    bankHoursPayoutEnd: {
                      ...policy.bankHoursPayoutEnd,
                      month: Number(e.target.value),
                    },
                  })
                }
                className="flex-1 px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {new Date(2000, i).toLocaleString('en', { month: 'short' })}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                max="31"
                value={policy.bankHoursPayoutEnd.day}
                onChange={(e) =>
                  onChange({
                    ...policy,
                    bankHoursPayoutEnd: {
                      ...policy.bankHoursPayoutEnd,
                      day: Number(e.target.value),
                    },
                  })
                }
                className="w-14 px-2 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Holidays */}
      <div>
        <button
          onClick={() => setShowHolidays(!showHolidays)}
          className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-300"
        >
          {showHolidays ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          Holidays ({policy.holidays.length})
        </button>

        {showHolidays && (
          <div className="mt-3 space-y-2">
            {policy.holidays.map((rule, i) => (
              <div
                key={i}
                className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-xs"
              >
                <span className="flex-1 truncate">{formatHolidayRule(rule)}</span>
                <button
                  onClick={() => removeHoliday(i)}
                  className="p-1 text-gray-400 hover:text-red-500 transition-colors duration-150"
                  aria-label={`Remove ${rule.name}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              onClick={addHoliday}
              className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400 transition-colors duration-150"
            >
              <Plus className="w-3.5 h-3.5" /> Add holiday
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
