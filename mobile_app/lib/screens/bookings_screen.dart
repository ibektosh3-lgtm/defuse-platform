import 'dart:async';
import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import '../theme/app_theme.dart';
import '../services/api_service.dart';
import '../services/lang_service.dart';
import '../widgets/review_dialog.dart';

class BookingsScreen extends StatefulWidget {
  const BookingsScreen({super.key});
  @override
  State<BookingsScreen> createState() => _BookingsScreenState();
}

class _BookingsScreenState extends State<BookingsScreen> {
  List _bookings = [];
  List _bulkGroups = []; // Bulk booking groups
  bool _loading = true;
  Timer? _timer;
  final Set<int> _warnedIds = {};
  final Set<int> _arrivalWarnedIds = {};

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      _checkExpiry();
      setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      // Ikkalasini birdaniga yuklaymiz
      final results = await Future.wait([
        ApiService.getMyBookings().catchError((_) => []),
        ApiService.getMyBookingGroups().catchError((_) => []),
      ]);
      if (mounted) {
        setState(() {
          _bookings = results[0];
          _bulkGroups = results[1];
          _loading = false;
        });
      }
      _checkExpiry();
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _checkExpiry() {
    for (final b in _bookings) {
      if (b['status'] != 'confirmed') continue;
      final id = b['id'] as int;

      // Bron vaqti keldi bildirishnomasi
      final arrivalNotifSent = b['arrival_notif_sent_at'];
      if (arrivalNotifSent != null && !_arrivalWarnedIds.contains(id)) {
        _arrivalWarnedIds.add(id);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _showArrivalDialog(b);
        });
        continue;
      }

      // 5 daqiqa qolganida ogohlantirish
      final expiresAt = b['expires_at'];
      if (expiresAt == null) continue;
      if (_warnedIds.contains(id)) continue;

      final expiry = DateTime.parse(expiresAt.toString()).toLocal();
      final diff = expiry.difference(DateTime.now());
      if (diff.inSeconds > 0 && diff.inSeconds <= 5 * 60) {
        _warnedIds.add(id);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _showWarningDialog(b);
        });
      }
    }
  }

  void _showArrivalDialog(Map b) {
    final id = b['id'] as int;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.card2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Row(children: [
          Text('🔔', style: TextStyle(fontSize: 28)),
          SizedBox(width: 8),
          Text('Bron vaqti keldi!', style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700)),
        ]),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${b['lab_name']} • PC #${b['computer_number']}',
              style: const TextStyle(color: AppColors.text2, fontSize: 13)),
            const SizedBox(height: 8),
            const Text('15 daqiqa ichida kirmasangiz bron bekor bo\'ladi.',
              style: TextStyle(color: AppColors.text3, fontSize: 12)),
            const SizedBox(height: 14),
            const Text('Uzaytirasizmi?',
              style: TextStyle(color: AppColors.text, fontSize: 13, fontWeight: FontWeight.w600)),
            const SizedBox(height: 10),
            Row(children: [3, 10, 15].map((m) => Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.green.withValues(alpha: 0.15),
                    foregroundColor: AppColors.green,
                    side: const BorderSide(color: AppColors.green),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    padding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  onPressed: () async {
                    Navigator.pop(context);
                    await _extendArrival(id, m);
                  },
                  child: Text('+$m\ndaq', textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                ),
              ),
            )).toList()),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              await _cancel(id);
            },
            child: const Text('Bekor qilish', style: TextStyle(color: AppColors.red)),
          ),
        ],
      ),
    );
  }

  Future<void> _extendArrival(int id, int minutes) async {
    try {
      await ApiService.extendBooking(id, minutes);
      _arrivalWarnedIds.remove(id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('+$minutes daqiqa uzaytirildi'),
        backgroundColor: AppColors.green,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ));
      _load();
    } on DioException catch (e) {
      final msg = e.response?.data?['error'] ?? 'Xatolik';
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), backgroundColor: AppColors.red),
      );
    }
  }

  void _showWarningDialog(Map b) {
    final id = b['id'] as int;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.card2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(children: [
          const Text('⏰', style: TextStyle(fontSize: 28)),
          const SizedBox(width: 8),
          Text(LangService.t('booking_expiring'), style: const TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700)),
        ]),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${b['lab_name']} • PC #${b['computer_number']}',
              style: const TextStyle(color: AppColors.text2, fontSize: 13)),
            const SizedBox(height: 12),
            Text(LangService.t('extend_booking'),
              style: const TextStyle(color: AppColors.text3, fontSize: 13)),
            const SizedBox(height: 14),
            Row(children: [5, 10, 20].map((m) => Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.orange.withValues(alpha: 0.15),
                    foregroundColor: AppColors.orange,
                    side: const BorderSide(color: AppColors.orange),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    padding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  onPressed: () async {
                    Navigator.pop(context);
                    await _extend(id, m);
                  },
                  child: Text('+$m\ndaq', textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                ),
              ),
            )).toList()),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(LangService.t('btn_no'), style: const TextStyle(color: AppColors.text3)),
          ),
        ],
      ),
    );
  }

  Future<void> _extend(int id, int minutes) async {
    try {
      await ApiService.extendBooking(id, minutes);
      _warnedIds.remove(id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('+$minutes daqiqa uzaytirildi'),
        backgroundColor: AppColors.orange,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ));
      _load();
    } on DioException catch (e) {
      final msg = e.response?.data?['error'] ?? 'Xatolik';
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), backgroundColor: AppColors.red),
      );
    }
  }

  Future<void> _openReview(Map b) async {
    final labIdRaw = b['lab_id'];
    final labId = labIdRaw is int ? labIdRaw : int.tryParse(labIdRaw?.toString() ?? '');
    if (labId == null) return;
    final sessionIdRaw = b['session_id'];
    final sessionId = sessionIdRaw is int ? sessionIdRaw : int.tryParse(sessionIdRaw?.toString() ?? '');
    final labName = b['lab_name']?.toString() ?? '';
    final result = await ReviewDialog.show(
      context,
      labId: labId,
      labName: labName,
      sessionId: sessionId,
    );
    if (result == true && mounted) _load();
  }

  Future<void> _cancel(dynamic id) async {
    try {
      await ApiService.cancelBooking(int.parse(id.toString()));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(LangService.t('booking_cancelled')),
          backgroundColor: AppColors.orange,
          behavior: SnackBarBehavior.floating,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      );
      _load();
    } on DioException catch (e) {
      final msg = e.response?.data?['error'] ?? 'Xatolik';
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), backgroundColor: AppColors.red),
      );
    }
  }

  String _formatDate(dynamic raw) {
    if (raw == null) return '';
    try {
      final dt = DateTime.parse(raw.toString()).toLocal();
      return '${dt.day.toString().padLeft(2,'0')}.${dt.month.toString().padLeft(2,'0')}.${dt.year}  ${dt.hour.toString().padLeft(2,'0')}:${dt.minute.toString().padLeft(2,'0')}';
    } catch (_) { return raw.toString(); }
  }

  String? _countdown(dynamic expiresAt) {
    if (expiresAt == null) return null;
    try {
      final exp = DateTime.parse(expiresAt.toString()).toLocal();
      final diff = exp.difference(DateTime.now());
      if (diff.isNegative) return '0:00';
      final m = diff.inMinutes;
      final s = diff.inSeconds % 60;
      return '$m:${s.toString().padLeft(2, '0')}';
    } catch (_) { return null; }
  }

  Widget _refundNote(Map b) {
    final scheduled = b['scheduled_at'];
    if (scheduled == null) return const SizedBox.shrink();
    try {
      final dt = DateTime.parse(scheduled.toString()).toLocal();
      final minutesLeft = dt.difference(DateTime.now()).inMinutes;
      final depositAmt = b['deposit_amount'];
      final hasDeposit = depositAmt != null && (depositAmt is num ? depositAmt > 0 : (double.tryParse(depositAmt.toString()) ?? 0) > 0);
      if (minutesLeft > 30) {
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: AppColors.green.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.green.withValues(alpha: 0.25)),
          ),
          child: const Row(children: [
            Text('✅', style: TextStyle(fontSize: 11)),
            SizedBox(width: 6),
            Expanded(child: Text('Bekor qilsangiz pul balansda qoladi',
              style: TextStyle(color: AppColors.green, fontSize: 11))),
          ]),
        );
      } else if (hasDeposit) {
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: AppColors.red.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.red.withValues(alpha: 0.25)),
          ),
          child: const Row(children: [
            Text('⚠️', style: TextStyle(fontSize: 11)),
            SizedBox(width: 6),
            Expanded(child: Text('30 daqiqadan kam qoldi — zalog qaytarilmaydi',
              style: TextStyle(color: AppColors.red, fontSize: 11))),
          ]),
        );
      }
    } catch (_) {}
    return const SizedBox.shrink();
  }

  Widget _statusBadge(String status) {
    final colors = {
      'confirmed': AppColors.green,
      'pending':   AppColors.cyan,
      'active':    AppColors.orange,
      'cancelled': AppColors.red,
      'completed': AppColors.text3,
      'expired':   AppColors.red,
    };
    final labels = {
      'confirmed': 'Tasdiqlangan',
      'pending':   'Kutmoqda',
      'active':    'Sessiyada',
      'cancelled': 'Bekor',
      'completed': 'Tugallangan',
      'expired':   "Muddati o'tdi",
    };
    final color = colors[status] ?? AppColors.cyan;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(20)),
      child: Text(labels[status] ?? status, style: TextStyle(color: color, fontSize: 11)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.bg2,
        title: Text(LangService.t('my_bookings'), style: const TextStyle(color: AppColors.text, fontWeight: FontWeight.w700)),
        leading: Navigator.canPop(context) ? IconButton(
          icon: const Icon(Icons.arrow_back_ios, color: AppColors.cyan),
          onPressed: () => Navigator.pop(context),
        ) : null,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.cyan),
            onPressed: () { setState(() => _loading = true); _load(); },
          ),
        ],
      ),
      body: _loading
        ? const Center(child: CircularProgressIndicator(color: AppColors.cyan))
        : (_bookings.isEmpty && _bulkGroups.isEmpty)
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text('📅', style: TextStyle(fontSize: 60)),
                  const SizedBox(height: 16),
                  Text(LangService.t('no_bookings'), style: const TextStyle(color: AppColors.text2, fontSize: 16)),
                  const SizedBox(height: 8),
                  Text(LangService.t('no_bookings_sub'), style: const TextStyle(color: AppColors.text3, fontSize: 13)),
                  const SizedBox(height: 24),
                  ElevatedButton(
                    onPressed: () => Navigator.pushNamed(context, '/map'),
                    child: Text(LangService.t('find_room')),
                  ),
                ],
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                // Bulk booking guruhlari (yangi)
                if (_bulkGroups.isNotEmpty) ...[
                  const Padding(
                    padding: EdgeInsets.only(bottom: 12),
                    child: Text('🎮 GURUH BRONLAR', style: TextStyle(
                        color: AppColors.mag, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
                  ),
                  ..._bulkGroups.map((g) => _bulkGroupCard(g)),
                  const SizedBox(height: 20),
                ],
                if (_bookings.isNotEmpty) ...[
                  const Padding(
                    padding: EdgeInsets.only(bottom: 12),
                    child: Text('📅 YAKKA BRONLAR', style: TextStyle(
                        color: AppColors.cyan, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
                  ),
                ],
                ..._bookings.map((b) {
                  final status = b['status'] ?? 'pending';
                final cd = status == 'confirmed' ? _countdown(b['expires_at']) : null;
                final isExpiring = cd != null && () {
                  final exp = DateTime.tryParse(b['expires_at'].toString())?.toLocal();
                  if (exp == null) return false;
                  return exp.difference(DateTime.now()).inSeconds <= 5 * 60;
                }();

                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: isExpiring ? AppColors.orange.withValues(alpha: 0.06) : AppColors.card2,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: isExpiring ? AppColors.orange.withValues(alpha: 0.5) : AppColors.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(b['lab_name'] ?? '',
                              style: const TextStyle(color: AppColors.text, fontWeight: FontWeight.w600, fontSize: 15)),
                          ),
                          _statusBadge(status),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text('📦 ${b['package_name'] ?? ''}  •  ${b['price'] ?? ''} so\'m',
                        style: const TextStyle(color: AppColors.text2, fontSize: 13)),
                      const SizedBox(height: 4),
                      Text('🕐 ${_formatDate(b['scheduled_at'])}',
                        style: const TextStyle(color: AppColors.text2, fontSize: 13)),
                      if (b['computer_number'] != null) ...[
                        const SizedBox(height: 4),
                        Text('🖥 PC #${b['computer_number']}',
                          style: const TextStyle(color: AppColors.cyan, fontSize: 12)),
                      ],
                      if (cd != null) ...[
                        const SizedBox(height: 8),
                        Row(children: [
                          Text('⏱ $cd',
                            style: TextStyle(
                              color: isExpiring ? AppColors.orange : AppColors.text3,
                              fontSize: 13,
                              fontWeight: isExpiring ? FontWeight.w700 : FontWeight.normal,
                            )),
                          if (isExpiring) ...[
                            const SizedBox(width: 8),
                            Text(LangService.t('expiring'),
                              style: const TextStyle(color: AppColors.orange, fontSize: 11)),
                          ],
                        ]),
                      ],
                      if (status == 'completed' && b['can_rate'] == true) ...[
                        const SizedBox(height: 10),
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton.icon(
                            onPressed: () => _openReview(b),
                            icon: const Text('⭐', style: TextStyle(fontSize: 14)),
                            label: const Text('Baholash',
                              style: TextStyle(color: AppColors.gold, fontSize: 13, fontWeight: FontWeight.w700)),
                            style: OutlinedButton.styleFrom(
                              side: BorderSide(color: AppColors.gold.withValues(alpha: 0.6)),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                          ),
                        ),
                      ],
                      if (status == 'confirmed') ...[
                        const SizedBox(height: 8),
                        // Refund sharhi
                        _refundNote(b),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            ...[5, 10, 20].map((m) => Padding(
                              padding: const EdgeInsets.only(right: 6),
                              child: GestureDetector(
                                onTap: () => _extend(b['id'] as int, m),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                                  decoration: BoxDecoration(
                                    color: AppColors.orange.withValues(alpha: 0.1),
                                    border: Border.all(color: AppColors.orange.withValues(alpha: 0.5)),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Text('+$m daq',
                                    style: const TextStyle(color: AppColors.orange, fontSize: 11, fontWeight: FontWeight.w700)),
                                ),
                              ),
                            )),
                            const Spacer(),
                            GestureDetector(
                              onTap: () => _cancel(b['id']),
                              child: Text(LangService.t('btn_cancel'),
                                style: const TextStyle(color: AppColors.red, fontSize: 12)),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                );
              }),
              ],
            ),
    );
  }

  // Bulk booking guruhi kartasi
  Widget _bulkGroupCard(Map g) {
    final status = (g['status'] ?? 'pending').toString();
    final seatCount = g['seat_count'] ?? g['total_seats'] ?? 0;
    final activatedSeats = g['activated_seats'] ?? 0;
    final totalAmount = g['total_amount'] ?? g['total_price'] ?? 0;
    final labName = g['lab_name'] ?? '';
    final packageName = g['package_name'] ?? '';
    final mode = (g['mode'] ?? 'strict').toString();
    final scheduled = g['scheduled_at']?.toString();

    Color statusColor;
    String statusText;
    switch (status) {
      case 'active':
      case 'partially_activated':
        statusColor = AppColors.cyan;
        statusText = 'Faol';
        break;
      case 'expired':
        statusColor = AppColors.red;
        statusText = 'Muddati o\'tdi';
        break;
      case 'cancelled':
        statusColor = AppColors.text3;
        statusText = 'Bekor';
        break;
      case 'completed':
        statusColor = AppColors.mag;
        statusText = 'Yakunlandi';
        break;
      default:
        statusColor = AppColors.orange;
        statusText = 'Kutilmoqda';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.card2,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.mag.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(labName.toString(),
                    style: const TextStyle(color: AppColors.text, fontWeight: FontWeight.w600, fontSize: 15)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: statusColor.withValues(alpha: 0.5)),
                ),
                child: Text(statusText,
                    style: TextStyle(color: statusColor, fontSize: 10, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text('👥 $seatCount kishi', style: const TextStyle(color: AppColors.mag, fontSize: 13, fontWeight: FontWeight.w700)),
              const SizedBox(width: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: (mode == 'strict' ? AppColors.cyan : AppColors.orange).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  mode == 'strict' ? '🎯 Aniq PC' : '🎲 Ixtiyoriy',
                  style: TextStyle(
                    color: mode == 'strict' ? AppColors.cyan : AppColors.orange,
                    fontSize: 10, fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text('📦 $packageName', style: const TextStyle(color: AppColors.text2, fontSize: 13)),
          const SizedBox(height: 4),
          Text('💰 ${totalAmount.toString()} so\'m', style: const TextStyle(color: AppColors.text2, fontSize: 13)),
          if (scheduled != null) ...[
            const SizedBox(height: 4),
            Text('🕐 ${_formatDate(scheduled)}', style: const TextStyle(color: AppColors.text2, fontSize: 13)),
          ],
          if (status == 'partially_activated') ...[
            const SizedBox(height: 8),
            LinearProgressIndicator(
              value: seatCount > 0 ? (activatedSeats as num).toDouble() / (seatCount as num).toDouble() : 0,
              backgroundColor: AppColors.border,
              valueColor: const AlwaysStoppedAnimation(AppColors.cyan),
              minHeight: 4,
            ),
            const SizedBox(height: 4),
            Text('$activatedSeats / $seatCount aktivatsiya qilindi',
                style: const TextStyle(color: AppColors.text3, fontSize: 11)),
          ],
          // Bekor qilish va vaqt o'zgartirish tugmalari — faqat kutmoqda holatda
          if (status == 'pending' || status == 'awaiting_payment') ...[
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: OutlinedButton.icon(
                onPressed: () => _rescheduleGroup(g),
                icon: const Icon(Icons.schedule, size: 16, color: AppColors.cyan),
                label: const Text('Vaqtni o\'zgartirish',
                    style: TextStyle(color: AppColors.cyan, fontSize: 12, fontWeight: FontWeight.w700)),
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: AppColors.cyan.withValues(alpha: 0.5)),
                  padding: const EdgeInsets.symmetric(vertical: 10),
                ),
              )),
              const SizedBox(width: 8),
              Expanded(child: OutlinedButton.icon(
                onPressed: () => _cancelGroup(g),
                icon: const Icon(Icons.close, size: 16, color: AppColors.red),
                label: Text(LangService.t('btn_cancel'),
                    style: const TextStyle(color: AppColors.red, fontSize: 12, fontWeight: FontWeight.w700)),
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: AppColors.red.withValues(alpha: 0.5)),
                  padding: const EdgeInsets.symmetric(vertical: 10),
                ),
              )),
            ]),
          ],
        ],
      ),
    );
  }

  Future<void> _cancelGroup(Map g) async {
    final gid = int.tryParse(g['id']?.toString() ?? '0') ?? 0;
    if (gid == 0) return;
    final confirmed = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      backgroundColor: AppColors.panel,
      title: const Text("Bronni bekor qilish?", style: TextStyle(color: AppColors.mag, fontSize: 16)),
      content: const Text(
        "Bekor qilingandan so'ng klub balansingizga qaytariladi.\n\n"
        "Faollashtirilgan seatlar (agar biror do'stingiz kirib bo'lgan bo'lsa) qaytarilmaydi.",
        style: TextStyle(color: Colors.white70)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Yo\'q', style: TextStyle(color: AppColors.text3))),
        TextButton(onPressed: () => Navigator.pop(ctx, true),
            child: const Text('HA, BEKOR QIL', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w700))),
      ],
    ));
    if (confirmed != true) return;
    try {
      final res = await ApiService.cancelBookingGroup(gid);
      if (!mounted) return;
      final refund = res['refunded'] ?? res['refund'] ?? 0;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        backgroundColor: AppColors.orange,
        content: Text('Bron bekor qilindi. ${(refund as num).toInt()} so\'m balansda qoldi'),
      ));
      _load();
    } on DioException catch (e) {
      if (!mounted) return;
      final msg = e.response?.data?['error']?.toString() ?? 'Xatolik';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        backgroundColor: AppColors.red, content: Text('❌ $msg'),
      ));
    }
  }

  Future<void> _rescheduleGroup(Map g) async {
    final gid = int.tryParse(g['id']?.toString() ?? '0') ?? 0;
    if (gid == 0) return;
    final current = DateTime.tryParse(g['scheduled_at']?.toString() ?? '')?.toLocal() ?? DateTime.now();
    final initial = current.isBefore(DateTime.now()) ? DateTime.now().add(const Duration(minutes: 10)) : current;

    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 30)),
      builder: (ctx, child) => Theme(
        data: ThemeData.dark().copyWith(colorScheme: const ColorScheme.dark(primary: AppColors.cyan, surface: AppColors.panel)),
        child: child!,
      ),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context, initialTime: TimeOfDay.fromDateTime(initial),
      builder: (ctx, child) => Theme(
        data: ThemeData.dark().copyWith(colorScheme: const ColorScheme.dark(primary: AppColors.cyan, surface: AppColors.panel)),
        child: child!,
      ),
    );
    if (time == null) return;

    final newDt = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    if (newDt.isBefore(DateTime.now().add(const Duration(minutes: 5)))) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        backgroundColor: AppColors.red, content: Text("O'tgan vaqtni tanlab bo'lmaydi"),
      ));
      return;
    }
    try {
      await ApiService.rescheduleBookingGroup(gid, newDt);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        backgroundColor: AppColors.cyan, content: Text("Bron vaqti o'zgartirildi ✓"),
      ));
      _load();
    } on DioException catch (e) {
      if (!mounted) return;
      final msg = e.response?.data?['error']?.toString() ?? 'Xatolik';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        backgroundColor: AppColors.red, content: Text('❌ $msg'),
      ));
    }
  }
}
