import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../services/api_service.dart';
import '../services/notification_service.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phoneCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _refCtrl = TextEditingController();
  bool _loading = false;
  bool _isLogin = true;
  bool _termsAccepted = false;
  bool _obscurePass = true;
  String? _error;

  // Telegram flow uchun polling timer — sahifa yopilsa bekor qilinsin
  Timer? _tgPollTimer;

  @override
  void dispose() {
    _tgPollTimer?.cancel();
    _phoneCtrl.dispose();
    _passCtrl.dispose();
    _nameCtrl.dispose();
    _refCtrl.dispose();
    super.dispose();
  }

  // ── Telegram deep-link ro'yxatdan o'tish ────────────────────────────────
  Future<void> _startTelegramFlow() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    Map<String, dynamic> initData;
    try {
      initData = await ApiService.tgInit();
    } catch (e) {
      setState(() {
        _loading = false;
        _error = 'Server bilan bog\'lanib bo\'lmadi';
      });
      return;
    }
    final tgToken = initData['token'] as String?;
    final botUrl = initData['bot_url'] as String?;
    if (tgToken == null || botUrl == null) {
      setState(() {
        _loading = false;
        _error = 'Telegram xizmati vaqtincha ishlamayapti';
      });
      return;
    }

    // Bot ochish
    final uri = Uri.parse(botUrl);
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!launched) {
      setState(() {
        _loading = false;
        _error = 'Telegram ilovasi topilmadi';
      });
      return;
    }

    setState(() => _loading = false);
    if (!mounted) return;

    // Polling + bottom sheet
    await _showTelegramWaitSheet(tgToken);
  }

  Future<void> _showTelegramWaitSheet(String tgToken) async {
    String? confirmedPhone;
    bool cancelled = false;

    await showModalBottomSheet<void>(
      context: context,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: AppColors.panel,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheet) {
            // Polling ni sheet ochilganda ishga tushiramiz
            _tgPollTimer ??= Timer.periodic(const Duration(seconds: 2), (_) async {
              try {
                final s = await ApiService.tgStatus(tgToken);
                if (s['status'] == 'confirmed' && s['phone'] != null) {
                  confirmedPhone = s['phone'] as String;
                  _tgPollTimer?.cancel();
                  _tgPollTimer = null;
                  if (Navigator.canPop(ctx)) Navigator.pop(ctx);
                }
              } catch (_) { /* keyingi tik kutamiz */ }
            });

            return Padding(
              padding: EdgeInsets.only(
                left: 20, right: 20, top: 24,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    const Icon(Icons.telegram, color: Color(0xFF229ED9), size: 28),
                    const SizedBox(width: 10),
                    Text('Telegram orqali ro\'yxat',
                      style: TextStyle(fontFamily: 'Archivo',
                        fontSize: 18, fontWeight: FontWeight.w800,
                        color: Colors.white)),
                  ]),
                  const SizedBox(height: 14),
                  Text(
                    'Telegram botga o\'ting va "📱 Telefon raqamimni yuborish" tugmasini bosing. Bu oyna avtomatik yopiladi.',
                    style: TextStyle(fontFamily: 'Archivo',
                      fontSize: 14, color: AppColors.muted, height: 1.5),
                  ),
                  const SizedBox(height: 20),
                  Row(children: const [
                    SizedBox(width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2)),
                    SizedBox(width: 12),
                    Text('Kutilmoqda...',
                      style: TextStyle(fontFamily: 'Archivo', color: Colors.white70)),
                  ]),
                  const SizedBox(height: 20),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: () {
                        cancelled = true;
                        _tgPollTimer?.cancel();
                        _tgPollTimer = null;
                        Navigator.pop(ctx);
                      },
                      child: const Text('Bekor qilish'),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );

    _tgPollTimer?.cancel();
    _tgPollTimer = null;

    if (cancelled || confirmedPhone == null) return;
    if (!mounted) return;

    // Ism + parol so'rash
    await _showTelegramCompleteSheet(tgToken, confirmedPhone!);
  }

  Future<void> _showTelegramCompleteSheet(String tgToken, String phone) async {
    final nameCtrl = TextEditingController();
    final passCtrl = TextEditingController();
    bool submitting = false;
    String? sheetError;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheet) {
            Future<void> submit() async {
              if (nameCtrl.text.trim().length < 2) {
                setSheet(() => sheetError = 'Ismingizni to\'liq kiriting');
                return;
              }
              if (passCtrl.text.length < 6) {
                setSheet(() => sheetError = 'Parol kamida 6 belgi bo\'lishi kerak');
                return;
              }
              setSheet(() { submitting = true; sheetError = null; });
              try {
                final data = await ApiService.tgComplete(
                  token: tgToken,
                  name: nameCtrl.text.trim(),
                  password: passCtrl.text,
                );
                await ApiService.saveToken(data['token']);
                final prefs = await SharedPreferences.getInstance();
                await prefs.setString('user', data['user'].toString());
                NotificationService.registerToken().ignore();
                if (!mounted) return;
                Navigator.pop(ctx);
                if (!mounted) return;
                Navigator.pushReplacementNamed(context, '/home');
              } on DioException catch (e) {
                final r = e.response;
                final msg = (r?.data is Map)
                    ? (r!.data['error']?.toString() ?? 'Xatolik')
                    : 'Server bilan aloqa yo\'q';
                setSheet(() { submitting = false; sheetError = msg; });
              } catch (e) {
                setSheet(() { submitting = false; sheetError = 'Xatolik: $e'; });
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 20, right: 20, top: 24,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Ma\'lumotlarni kiriting',
                    style: TextStyle(fontFamily: 'Archivo',
                      fontSize: 20, fontWeight: FontWeight.w800,
                      color: Colors.white)),
                  const SizedBox(height: 6),
                  Text('Telefon: $phone',
                    style: TextStyle(fontFamily: 'Archivo',
                      fontSize: 13, color: AppColors.muted)),
                  const SizedBox(height: 18),
                  Text('ISMINGIZ',
                    style: TextStyle(fontFamily: 'ChakraPetch',
                      fontSize: 11, letterSpacing: 0.16 * 11,
                      color: AppColors.muted)),
                  const SizedBox(height: 8),
                  TextField(
                    controller: nameCtrl,
                    style: TextStyle(fontFamily: 'Archivo',
                      color: AppColors.text, fontWeight: FontWeight.w600),
                    decoration: const InputDecoration(hintText: 'Bektosh'),
                  ),
                  const SizedBox(height: 14),
                  Text('PAROL (kamida 6 belgi)',
                    style: TextStyle(fontFamily: 'ChakraPetch',
                      fontSize: 11, letterSpacing: 0.16 * 11,
                      color: AppColors.muted)),
                  const SizedBox(height: 8),
                  TextField(
                    controller: passCtrl,
                    obscureText: true,
                    style: TextStyle(fontFamily: 'Archivo',
                      color: AppColors.text, fontWeight: FontWeight.w600),
                    decoration: const InputDecoration(hintText: '••••••••'),
                  ),
                  if (sheetError != null) ...[
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppColors.red.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.red.withValues(alpha: 0.4)),
                      ),
                      child: Text(sheetError!,
                        style: TextStyle(fontFamily: 'Archivo',
                          fontSize: 13, color: AppColors.red)),
                    ),
                  ],
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: submitting ? null : submit,
                      child: submitting
                          ? const SizedBox(height: 18, width: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.white))
                          : const Text('Ro\'yxatdan o\'tish'),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );

    nameCtrl.dispose();
    passCtrl.dispose();
  }

  Future<void> _submit() async {
    final raw = _phoneCtrl.text
        .trim()
        .replaceAll(' ', '')
        .replaceAll('-', '')
        .replaceAll('(', '')
        .replaceAll(')', '');
    final phoneClean = raw.startsWith('+')
        ? raw
        : raw.startsWith('998')
            ? '+$raw'
            : '+998$raw';
    if (!RegExp(r'^\+998\d{9}$').hasMatch(phoneClean)) {
      setState(() =>
          _error = 'Telefon format noto\'g\'ri. Namuna: 901234567');
      return;
    }
    if (_passCtrl.text.length < 4) {
      setState(() => _error = 'Parol kamida 4 belgi bo\'lishi kerak');
      return;
    }
    if (!_isLogin && _nameCtrl.text.trim().length < 2) {
      setState(() => _error = 'Ismingizni to\'liq kiriting');
      return;
    }
    if (!_isLogin && !_termsAccepted) {
      setState(() => _error = 'Foydalanish shartlarini qabul qiling');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = _isLogin
          ? await ApiService.login(phoneClean, _passCtrl.text)
          : await ApiService.register(
              _nameCtrl.text.trim(), phoneClean, _passCtrl.text,
              referralCode: _refCtrl.text.trim().isEmpty ? null : _refCtrl.text.trim());
      await ApiService.saveToken(data['token']);
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('user', data['user'].toString());
      NotificationService.registerToken().ignore();
      if (!mounted) return;
      Navigator.pushReplacementNamed(context, '/home');
    } catch (e) {
      String msg = 'Kirishda xatolik';
      if (e is DioException) {
        final r = e.response;
        if (r != null) {
          if (r.statusCode == 429) {
            msg = 'Juda ko\'p urinish. 5 daqiqa kuting';
          } else if (r.statusCode == 400 || r.statusCode == 401) {
            msg = (r.data is Map
                ? (r.data['error']?.toString() ??
                    'Telefon yoki parol noto\'g\'ri')
                : 'Telefon yoki parol noto\'g\'ri');
          } else if (r.statusCode == 403) {
            msg = 'Ruxsat yo\'q';
          } else {
            msg = 'Server javobi ${r.statusCode}';
          }
        } else {
          switch (e.type) {
            case DioExceptionType.connectionTimeout:
            case DioExceptionType.sendTimeout:
            case DioExceptionType.receiveTimeout:
              msg = 'Internet sekin ishlayapti. Qayta urinib ko\'ring';
              break;
            case DioExceptionType.connectionError:
              msg = 'Serverga ulanish yo\'q. Wi-Fi tekshiring';
              break;
            default:
              msg = 'Xatolik: ${e.message ?? e.type.name}';
          }
        }
      }
      setState(() => _error = msg);
    }
    setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 52),
              // Logo
              ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: Image.asset(
                  'assets/images/logo.png',
                  width: 44,
                  height: 44,
                  fit: BoxFit.cover,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                _isLogin ? 'Xush kelibsiz' : 'Hisob yaratish',
                style: TextStyle(fontFamily: 'Archivo', 
                  fontSize: 28,
                  fontWeight: FontWeight.w900,
                  letterSpacing: -0.02 * 28,
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                _isLogin
                    ? 'Telefon raqamingiz bilan kiring va joy band qilishni boshlang.'
                    : 'Bir daqiqa vaqt oladi. Keyin istalgan klubda joy band qila olasiz.',
                style: TextStyle(fontFamily: 'Archivo', 
                  fontSize: 14,
                  color: AppColors.muted,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 26),

              // Form fields
              if (!_isLogin) ...[
                _monoLabel('ISMINGIZ'),
                const SizedBox(height: 8),
                _inputField(
                  controller: _nameCtrl,
                  hint: 'Bektosh',
                  keyboardType: TextInputType.name,
                ),
                const SizedBox(height: 14),
              ],
              _monoLabel('TELEFON'),
              const SizedBox(height: 8),
              _phoneField(),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _monoLabel('PAROL'),
                  if (_isLogin)
                    GestureDetector(
                      onTap: () => Navigator.pushNamed(context, '/forgot-password'),
                      child: Text(
                        'Unutdingizmi?',
                        style: TextStyle(fontFamily: 'Archivo', 
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: AppColors.violetLight,
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              _inputField(
                controller: _passCtrl,
                hint: '••••••••',
                obscureText: _obscurePass,
                onSubmit: _submit,
                suffix: GestureDetector(
                  onTap: () => setState(() => _obscurePass = !_obscurePass),
                  child: Icon(
                    _obscurePass ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                    size: 18,
                    color: AppColors.muted,
                  ),
                ),
              ),

              // Referral code field (register only)
              if (!_isLogin) ...[
                const SizedBox(height: 12),
                _inputField(
                  controller: _refCtrl,
                  hint: '🎁 Referral kod (ixtiyoriy)',
                ),
              ],

              // Terms checkbox (register only)
              if (!_isLogin) ...[
                const SizedBox(height: 16),
                GestureDetector(
                  onTap: () => setState(() => _termsAccepted = !_termsAccepted),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: 20,
                        height: 20,
                        decoration: BoxDecoration(
                          color: _termsAccepted
                              ? AppColors.violet
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(
                            color: _termsAccepted
                                ? AppColors.violet
                                : AppColors.line2,
                          ),
                        ),
                        child: _termsAccepted
                            ? const Icon(Icons.check, size: 13, color: Colors.white)
                            : null,
                      ),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Text(
                          'Foydalanish shartlari va maxfiylik siyosatiga roziman',
                          style: TextStyle(fontFamily: 'Archivo', 
                            fontSize: 13,
                            color: AppColors.muted,
                            height: 1.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              // Error
              if (_error != null) ...[
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.red.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.red.withValues(alpha: 0.4)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline,
                          color: AppColors.red, size: 16),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _error!,
                          style: TextStyle(fontFamily: 'Archivo', 
                              fontSize: 13, color: AppColors.red),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: 20),

              // Primary button
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _loading ? null : _submit,
                  child: _loading
                      ? const SizedBox(
                          height: 18,
                          width: 18,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white),
                        )
                      : Text(_isLogin ? 'Kirish' : 'Ro\'yxatdan o\'tish'),
                ),
              ),

              if (_isLogin) ...[
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(child: Container(height: 1, color: const Color(0xFF1B1D21))),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Text(
                        'yoki',
                        style: TextStyle(fontFamily: 'ChakraPetch', 
                          fontSize: 10,
                          letterSpacing: 0.14 * 10,
                          color: AppColors.faint,
                        ),
                      ),
                    ),
                    Expanded(child: Container(height: 1, color: const Color(0xFF1B1D21))),
                  ],
                ),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: _loading ? null : _startTelegramFlow,
                    child: const Text('Telegram orqali ro\'yxat'),
                  ),
                ),
              ],

              const SizedBox(height: 24),
              Center(
                child: GestureDetector(
                  onTap: () => setState(() {
                    _isLogin = !_isLogin;
                    _error = null;
                  }),
                  child: RichText(
                    text: TextSpan(
                      style: TextStyle(fontFamily: 'Archivo', 
                          fontSize: 14, color: AppColors.muted),
                      children: [
                        TextSpan(
                          text: _isLogin
                              ? 'Hisobingiz yo\'qmi? '
                              : 'Hisobingiz bormi? ',
                        ),
                        TextSpan(
                          text: _isLogin ? 'Ro\'yxatdan o\'tish' : 'Kirish',
                          style: TextStyle(fontFamily: 'Archivo', 
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                            color: AppColors.violetLight,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 32),
            ],
          ),
        ),
      ),
    );
  }

  Widget _monoLabel(String text) {
    return Text(
      text,
      style: TextStyle(fontFamily: 'ChakraPetch', 
        fontSize: 11,
        letterSpacing: 0.16 * 11,
        color: AppColors.muted,
      ),
    );
  }

  Widget _phoneField() {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.line2),
      ),
      child: Row(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
            child: Text(
              '+998',
              style: TextStyle(fontFamily: 'Archivo', 
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: AppColors.muted),
            ),
          ),
          Container(width: 1, height: 18, color: AppColors.line2),
          Expanded(
            child: TextField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              style: TextStyle(fontFamily: 'Archivo', 
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: AppColors.text),
              decoration: InputDecoration(
                hintText: '93 123 45 67',
                hintStyle: TextStyle(fontFamily: 'Archivo', 
                    fontSize: 15, color: AppColors.faint),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(
                    horizontal: 12, vertical: 15),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _inputField({
    required TextEditingController controller,
    required String hint,
    bool obscureText = false,
    TextInputType? keyboardType,
    VoidCallback? onSubmit,
    Widget? suffix,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscureText,
      keyboardType: keyboardType,
      style: TextStyle(fontFamily: 'Archivo', 
          fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.text),
      onSubmitted: onSubmit == null ? null : (_) => onSubmit(),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle:
            TextStyle(fontFamily: 'Archivo', fontSize: 15, color: AppColors.faint),
        suffixIcon: suffix != null
            ? Padding(
                padding: const EdgeInsets.only(right: 14),
                child: suffix,
              )
            : null,
        suffixIconConstraints: const BoxConstraints(),
      ),
    );
  }
}

