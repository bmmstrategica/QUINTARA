-- Why Quintara cancelled a booking (one booking, or the whole experience), shown to the member with the booking.
-- Null when the member cancelled it themselves.
ALTER TABLE experience_bookings ADD COLUMN cancelled_by_quintara_reason TEXT CHECK (char_length(cancelled_by_quintara_reason) <= 300);
