import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../theme/app_theme.dart';
import '../services/api_service.dart';
import '../services/lang_service.dart';
import '../widgets/hud.dart';
import '../widgets/lab_card.dart';
import 'promotions_screen.dart';
import 'tournament_screen.dart';
import 'friends_screen.dart';

class HomeScreen extends StatefulWidget {
  final VoidCallback? onGoToClubs;
  final VoidCallback? onGoToRank;
  final VoidCallback? onGoToWallet;
  final VoidCallback? onGoToProfile;
  const HomeScreen({
    super.key,
    this.onGoToClubs,
    this.onGoToRank,
    this.onGoToWallet,
    this.onGoToProfile,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

// Helper: PG NUMERIC/BIGINT string sifatida qaytishi mumkin, xavfsiz parse
int _toInt(dynamic v, [int fallback = 0]) {
  if (v == null) return fallback;
  if (v is int) return v;
  if (v is double) return v.toInt();
  return int.tryParse(v.toString().split('.').first) ?? fallback;
}
class _HomeScreenState extends State<HomeScreen> {
  List _labs = [];
  List _labBalances = [];
  List _favoriteLabs = [];
  final Set<int> _favoriteIds = {};
  Map<String, dynamic>? _user;
  Map<String, dynamic>? _agentState;
  List _announcements = [];
  List _activeTournaments = [];
  List _promos = [];
  List _onlineFriends = [];
  bool _showPromoBanner = true;
  bool _loading = true;
  String? _loadError;

  static const int _defaultLabId = 11;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<Position?> _getUserLocation() async {
    // Butun geolokatsiya oqimini 4 sekundlik timeout ichida bajaramiz.
    // Foydalanuvchi ruxsat berishga qaror qilmasa yoki geolokatsiya bloklansa —
    // home ekran ochilishini kutmasin.
    try {
      return await Future.any([
        () async {
          final serviceEnabled = await Geolocator.isLocationServiceEnabled();
          if (!serviceEnabled) return null;
          var perm = await Geolocator.checkPermission();
          if (perm == LocationPermission.denied) {
            perm = await Geolocator.requestPermission();
          }
          if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) return null;
          return await Geolocator.getCurrentPosition(
            locationSettings: const LocationSettings(accuracy: LocationAccuracy.low, timeLimit: Duration(seconds: 3)),
          );
        }(),
        Future.delayed(const Duration(seconds: 4), () => null),
      ]);
    } catch (_) { return null; }
  }

  Future<void> _load() async {
    try {
      // Geolokatsiya + me + balances parallel
      final results = await Future.wait([
        _getUserLocation(),
        ApiService.getMe(),
        ApiService.getLabBalances().catchError((_) => []),
      ]);
      final pos = results[0] as Position?;
      final me = results[1] as Map<String, dynamic>;
      final labBalances = results[2] as List;

      // Labs (geolokatsiyaga bog'liq) + agentState + promos parallel
      final defaultLabId = _defaultLabId;
      final results2 = await Future.wait([
        ApiService.getLabs(lat: pos?.latitude, lng: pos?.longitude),
        ApiService.getAgentState(labId: defaultLabId).catchError((_) => null),
        ApiService.getLabPromos(defaultLabId).catchError((_) => []),
      ]);
      final labs = results2[0] as List;
      final state = results2[1] as Map<String, dynamic>?;
      final promos = results2[2] as List;

      // E'lonlar — topilgan lablar bo'yicha parallel
      List announcements = [];
      try {
        final annFutures = labs.take(3).map((lab) {
          final id = _toInt(lab['id']);
          return id > 0
              ? ApiService.getAnnouncements(id).catchError((_) => [])
              : Future.value([]);
        }).toList();
        final annResults = await Future.wait(annFutures);
        for (int i = 0; i < annResults.length; i++) {
          final labName = i < labs.length ? (labs[i]['name']?.toString() ?? '') : '';
          for (final a in (annResults[i] as List)) {
            if (a is Map) announcements.add({...a, 'lab_name': labName});
          }
        }
        announcements.sort((a, b) {
          final ap = (a['is_pinned'] == true) ? 1 : 0;
          final bp = (b['is_pinned'] == true) ? 1 : 0;
          if (ap != bp) return bp.compareTo(ap);
          return (b['created_at']?.toString() ?? '').compareTo(a['created_at']?.toString() ?? '');
        });
      } catch (_) {}

      List activeTournaments = [];
      try {
        final all = await ApiService.getAllTournaments();
        activeTournaments = (all as List).where((t) => t['status'] == 'active' || t['status'] == 'upcoming').toList();
      } catch (_) {}

      List favoriteLabs = [];
      try { favoriteLabs = await ApiService.getFavoriteLabs(); } catch (_) {}

      List onlineFriends = [];
      try { onlineFriends = await ApiService.getFriends(onlineOnly: true); } catch (_) {}

      setState(() {
        _labs = labs;
        _labBalances = labBalances;
        _favoriteLabs = favoriteLabs;
        _favoriteIds
          ..clear()
          ..addAll(favoriteLabs.map<int>((l) => _toInt(l['id'])));
        _user = me;
        _agentState = state;
        _announcements = announcements;
        _activeTournaments = activeTournaments;
        _promos = promos;
        _onlineFriends = onlineFriends;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      final statusCode = e is DioException ? e.response?.statusCode : null;
      if (statusCode == 401 || statusCode == 403) {
        await ApiService.removeToken();
        Navigator.pushReplacementNamed(context, '/login');
      } else {
        setState(() { _loading = false; _loadError = LangService.t('error'); });
      }
    }
  }

  Future<void> _claimDailyBonus() async {
    try {
      final res = await ApiService.claimDailyBonus();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: AppColors.panel,
          content: Text(res['message']?.toString() ?? '🎁 Bonus olindi!'),
        ),
      );
      _load();
    } catch (e) {
      if (!mounted) return;
      final msg = e.toString().contains('allaqachon')
        ? 'Bugungi bonus allaqachon olingan. Ertaga qayting!'
        : 'Bonus olishda xatolik';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(backgroundColor: AppColors.panel, content: Text(msg)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const HudBackground(
        child: Center(child: CircularProgressIndicator(color: AppColors.mag)),
      );
    }
    if (_loadError != null && _labs.isEmpty) {
      return HudBackground(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('⚠️', style: TextStyle(fontSize: 40)),
              const SizedBox(height: 12),
              Text(_loadError!, style: HudType.bodySmall(size: 13)),
              const SizedBox(height: 16),
              HudButton(
                label: LangService.t('retry'),
                onPressed: () => setState(() { _loading = true; _loadError = null; _load(); }),
                background: AppColors.mag,
                foreground: AppColors.text,
                cornerSize: 8,
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              ),
            ],
          ),
        ),
      );
    }
    final name = (_user?['name'] ?? 'MIJOZ').toString();
    final gamerTag = _user?['gamer_tag']?.toString() ?? '';
    final displayName = gamerTag.isNotEmpty ? '@$gamerTag' : name.toUpperCase();
    final firstLetter = name.isNotEmpty ? name[0].toUpperCase() : 'A';
    final avatarUrl = _user?['avatar_url']?.toString();
    final balance = int.tryParse(_user?['balance']?.toString() ?? '0') ?? 0;

    // Xato ushlab qolish uchun try-catch wrapper
    try {
      return _buildHome(name, firstLetter, balance, avatarUrl, displayName: displayName);
    } catch (e) {
      return HudBackground(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${LangService.t('welcome')}, $name', style: HudType.title(size: 20)),
                const SizedBox(height: 8),
                Text('${LangService.t('balance')}: $balance so\'m', style: HudType.bodySmall(size: 14)),
                const SizedBox(height: 24),
                Text('${LangService.t('load_error_home')}: $e', style: HudType.bodySmall().copyWith(color: AppColors.mag)),
                const SizedBox(height: 16),
                TextButton(onPressed: _load, child: Text(LangService.t('btn_retry_upper'), style: const TextStyle(color: AppColors.cyan))),
              ],
            ),
          ),
        ),
      );
    }
  }

  Widget _buildHome(String name, String firstLetter, int balance, String? avatarUrl, {String? displayName}) {
    final resolvedDisplayName = displayName ?? name.toUpperCase();
    return HudBackground(
      child: RefreshIndicator(
        color: AppColors.mag,
        backgroundColor: AppColors.panel,
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 56, 18, 100),
          children: [
            // === Salom + profil ===
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(LangService.t('welcome'), style: HudType.bodySmall(size: 12.5)),
                    const SizedBox(height: 2),
                    Text(resolvedDisplayName, style: HudType.title(size: 19)),
                    if (_onlineFriends.isNotEmpty)
                      GestureDetector(
                        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const FriendsScreen())),
                        child: Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            const Icon(Icons.circle, color: AppColors.lime, size: 8),
                            const SizedBox(width: 4),
                            Text('${_onlineFriends.length} ta do\'sting online',
                                style: const TextStyle(color: AppColors.lime, fontSize: 11, fontWeight: FontWeight.w600)),
                          ]),
                        ),
                      ),
                  ],
                ),
                GestureDetector(
                  onTap: widget.onGoToProfile ?? widget.onGoToRank,
                  child: Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(14),
                      gradient: avatarUrl == null || avatarUrl.isEmpty
                          ? const LinearGradient(
                              colors: [AppColors.violet, AppColors.violetLight],
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                            )
                          : null,
                      boxShadow: [
                        BoxShadow(
                          color: AppColors.violet.withValues(alpha: 0.5),
                          blurRadius: 16,
                          spreadRadius: -2,
                        ),
                      ],
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: avatarUrl != null && avatarUrl.isNotEmpty
                          ? Image.network(
                              avatarUrl,
                              width: 46,
                              height: 46,
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => Center(
                                child: Text(
                                  firstLetter,
                                  style: const TextStyle(
                                    fontSize: 18,
                                    fontWeight: FontWeight.w700,
                                    color: Colors.white,
                                  ),
                                ),
                              ),
                            )
                          : Center(
                              child: Text(
                                firstLetter,
                                style: const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w700,
                                  color: Colors.white,
                                ),
                              ),
                            ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),

            // Aktiv promo banner (dismiss qilinadi)
            if (_showPromoBanner && _promos.isNotEmpty) ...[
              _buildPromoBanner(_promos.first),
              const SizedBox(height: 12),
            ],


            // === Hamyon kartasi (neon ramka) ===
            NeonEdge(
              cornerSize: 13,
              padding: 1.4,
              gradient: const [AppColors.mag, AppColors.violet, AppColors.cyan],
              innerColor: const Color(0xFF1A0F1D),
              innerPadding: const EdgeInsets.all(18),
              child: Stack(
                children: [
                  // ko'rinmas cyan glow (sodda Container o'rniga)
                  Positioned(
                    right: -40,
                    bottom: -50,
                    child: Container(
                      width: 160,
                      height: 160,
                      decoration: const BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [Color(0x5927E0FF), Color(0x0027E0FF)],
                          stops: [0, 0.7],
                        ),
                      ),
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(LangService.t('lab_balances'), style: HudType.hudLabel(size: 10).copyWith(letterSpacing: 1.6)),
                      const SizedBox(height: 8),
                      // Har klub balansi alohida — mavjud bo'lganlar
                      if (_labBalances.isEmpty)
                        Text(
                          LangService.t('no_lab_balance'),
                          style: HudType.bodySmall(size: 12).copyWith(color: AppColors.muted),
                        )
                      else
                        ..._labBalances.map((lb) {
                          final labName = lb['lab_name']?.toString() ?? 'Klub';
                          final bal = num.tryParse(lb['balance']?.toString() ?? '0')?.toInt() ?? 0;
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 6),
                            child: Row(children: [
                              Container(width: 6, height: 22,
                                decoration: BoxDecoration(
                                  color: AppColors.cyan,
                                  borderRadius: BorderRadius.circular(2))),
                              const SizedBox(width: 10),
                              Expanded(child: Text(labName,
                                  style: HudType.bodySmall(size: 13).copyWith(color: AppColors.text))),
                              Text('${bal.toString().replaceAllMapped(RegExp(r"(\d)(?=(\d{3})+$)"), (m) => "${m[1]} ")} so\'m',
                                  style: HudType.title(size: 14, color: AppColors.lime)),
                            ]),
                          );
                        }),
                      const SizedBox(height: 10),
                      Text(
                        LangService.t('balance_hint'),
                        style: HudType.bodySmall(size: 10).copyWith(color: AppColors.muted),
                      ),
                      const SizedBox(height: 12),
                      HudButton(
                        label: LangService.t('btn_select_club'),
                        onPressed: () => Navigator.pushNamed(context, '/my-clubs'),
                        background: AppColors.mag,
                        expand: true,
                        cornerSize: 5,
                        padding: const EdgeInsets.symmetric(vertical: 11),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),

            // === 2 tezkor amal ===
            Row(
              children: [
                Expanded(child: _quickAction(Icons.local_offer_outlined,
                    LangService.t('nav_deals'), () => Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const PromotionsScreen())))),
                const SizedBox(width: 8),
                Expanded(child: _quickAction(Icons.event_available_outlined,
                    LangService.t('bookings_'), () => Navigator.pushNamed(context, '/bookings'))),
              ],
            ),

            // === Faol turnirlar banneri ===
            if (_activeTournaments.isNotEmpty) ...[
              const SizedBox(height: 14),
              GestureDetector(
                onTap: () {
                  final t = _activeTournaments.first;
                  final id = t['id'];
                  if (id != null) {
                    Navigator.pushNamed(context, '/tournament-detail', arguments: id is int ? id : int.tryParse(id.toString()) ?? 0);
                  } else {
                    Navigator.push(context, MaterialPageRoute(builder: (_) => const TournamentScreen()));
                  }
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(colors: [
                      AppColors.gold.withValues(alpha: 0.18),
                      AppColors.gold.withValues(alpha: 0.06),
                    ]),
                    border: Border.all(color: AppColors.gold, width: 1.5),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    children: [
                      const Text('🏆', style: TextStyle(fontSize: 22)),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('FAOL TURNIR${_activeTournaments.length > 1 ? "LAR (${_activeTournaments.length})" : ""}',
                                style: HudType.hudLabel(color: AppColors.gold, size: 10)),
                            const SizedBox(height: 2),
                            Text(_activeTournaments.first['name']?.toString() ?? '', style: HudType.bodySmall(size: 13)),
                          ],
                        ),
                      ),
                      const Icon(Icons.arrow_forward_ios, color: AppColors.gold, size: 14),
                    ],
                  ),
                ),
              ),
            ],

            // === E'lonlar / Chegirmalar (klub egalari yuborgan) ===
            if (_announcements.isNotEmpty) ...[
              const SizedBox(height: 22),
              HudLabel(LangService.t('announcements')),
              const SizedBox(height: 10),
              SizedBox(
                height: 128,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: _announcements.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 10),
                  itemBuilder: (ctx, i) => _announcementCard(_announcements[i] as Map),
                ),
              ),
            ],

            // === Sec ===
            const SizedBox(height: 22),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                HudLabel(LangService.t('nearest_clubs')),
                GestureDetector(
                  onTap: widget.onGoToClubs,
                  child: Text(
                    LangService.t('map_link'),
                    style: HudType.hudLabel(color: AppColors.cyan, size: 11).copyWith(letterSpacing: 0.6),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),

            // === Sevimli klublar ===
            if (_favoriteLabs.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(children: [
                  const Text('❤️', style: TextStyle(fontSize: 14)),
                  const SizedBox(width: 6),
                  Text('Sevimli klublar', style: HudType.hudLabel(size: 11, color: AppColors.mag)),
                ]),
              ),
              SizedBox(
                height: 90,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: _favoriteLabs.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (_, i) {
                    final lab = _favoriteLabs[i];
                    return GestureDetector(
                      onTap: () => Navigator.pushNamed(context, '/lab', arguments: lab),
                      child: Container(
                        width: 130,
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AppColors.panel,
                          border: Border.all(color: AppColors.mag.withValues(alpha: 0.4)),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                          Text(lab['name']?.toString() ?? '', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700), maxLines: 1, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 4),
                          Text(lab['address']?.toString() ?? '', style: TextStyle(color: AppColors.text3, fontSize: 10), maxLines: 1, overflow: TextOverflow.ellipsis),
                        ]),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 16),
            ],

            // === Klublar ===
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Center(child: CircularProgressIndicator(color: AppColors.mag)),
              )
            else if (_labs.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 40),
                child: Center(
                  child: Text('Klublar topilmadi', style: HudType.bodySmall()),
                ),
              )
            else
              ..._labs.map((lab) {
                final labId = _toInt(lab['id']);
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: LabCard(
                    lab: lab as Map<String, dynamic>,
                    isFavorite: _favoriteIds.contains(labId),
                    onFavoriteToggle: () async {
                      final isFav = await ApiService.toggleFavoriteLab(labId);
                      setState(() {
                        if (isFav) { _favoriteIds.add(labId); _favoriteLabs = [lab, ..._favoriteLabs.where((l) => _toInt(l['id']) != labId)]; }
                        else { _favoriteIds.remove(labId); _favoriteLabs = _favoriteLabs.where((l) => _toInt(l['id']) != labId).toList(); }
                      });
                    },
                    onTap: () => Navigator.pushNamed(context, '/lab', arguments: lab),
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  Widget _announcementCard(Map a) {
    final type = a['type']?.toString() ?? 'news';
    final meta = {
      'news':       {'icon': '📰', 'label': 'YANGILIK',  'color': AppColors.cyan},
      'discount':   {'icon': '🎁', 'label': 'CHEGIRMA',  'color': AppColors.mag},
      'event':      {'icon': '🎉', 'label': 'TADBIR',    'color': AppColors.violet},
      'tournament': {'icon': '🏆', 'label': 'TURNIR',    'color': AppColors.amber},
    };
    final m = meta[type] ?? meta['news']!;
    final color = m['color'] as Color;
    final isPinned = a['is_pinned'] == true;
    final title = a['title']?.toString() ?? '';
    final body = a['body']?.toString() ?? '';
    final labName = a['lab_name']?.toString() ?? '';

    return SizedBox(
      width: 280,
      child: HudCard(
        cornerSize: 8,
        borderColor: color,
        padding: const EdgeInsets.all(12),
        onTap: () => showModalBottomSheet(
          context: context,
          backgroundColor: AppColors.panel,
          isScrollControlled: true,
          builder: (_) => _announcementDetail(a, color, m['icon'] as String, m['label'] as String),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(m['icon'] as String, style: const TextStyle(fontSize: 14)),
                const SizedBox(width: 6),
                Text(m['label'] as String, style: HudType.hudLabel(color: color, size: 10)),
                const Spacer(),
                if (isPinned) Text('📌', style: const TextStyle(fontSize: 10)),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: HudType.title(size: 13),
            ),
            const SizedBox(height: 4),
            Expanded(
              child: Text(
                body,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: HudType.bodySmall(size: 11),
              ),
            ),
            if (labName.isNotEmpty)
              Text(
                '🏢 $labName',
                style: HudType.hudLabel(color: AppColors.muted, size: 9),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ),
      ),
    );
  }

  Widget _announcementDetail(Map a, Color color, String icon, String label) {
    final title = a['title']?.toString() ?? '';
    final body = a['body']?.toString() ?? '';
    final labName = a['lab_name']?.toString() ?? '';
    final imageUrl = a['image_url']?.toString();
    final endsAt = a['ends_at']?.toString();
    return Container(
      padding: EdgeInsets.only(
        left: 20, right: 20, top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(icon, style: const TextStyle(fontSize: 18)),
              const SizedBox(width: 8),
              Text(label, style: HudType.hudLabel(color: color, size: 12)),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.close, color: AppColors.muted),
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(title, style: HudType.title(size: 18)),
          if (labName.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('🏢 $labName', style: HudType.bodySmall(size: 12).copyWith(color: AppColors.muted)),
          ],
          if (imageUrl != null && imageUrl.isNotEmpty) ...[
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Image.network(imageUrl, height: 160, width: double.infinity, fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const SizedBox.shrink()),
            ),
          ],
          const SizedBox(height: 12),
          Text(body, style: HudType.bodySmall(size: 13)),
          if (endsAt != null && endsAt.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text('⏱ Tugaydi: $endsAt', style: HudType.hudLabel(color: AppColors.amber, size: 10)),
          ],
        ],
      ),
    );
  }

  Widget _buildPromoBanner(dynamic promo) {
    final p = (promo is Map) ? promo : <String, dynamic>{};
    final code = p['code']?.toString() ?? '';
    final title = p['title']?.toString() ?? p['name']?.toString() ?? 'Aksiya';
    final discount = p['discount_percent'] ?? p['bonus_percent'] ?? p['percent'];
    final subtitle = discount != null
        ? '$code — $discount% bonus'
        : (title.isNotEmpty ? title : code);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFF191507),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.gold, width: 1.2),
      ),
      child: Row(children: [
        const Text('🏷', style: TextStyle(fontSize: 20)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('AKSIYA',
                  style: HudType.hudLabel(size: 10, color: AppColors.gold)),
              const SizedBox(height: 2),
              Text(subtitle,
                  style: HudType.bodySmall(size: 13)
                      .copyWith(color: const Color(0xFFE8D9B8), fontWeight: FontWeight.w700)),
            ],
          ),
        ),
        GestureDetector(
          onTap: () => setState(() => _showPromoBanner = false),
          child: const Padding(
            padding: EdgeInsets.all(4),
            child: Icon(Icons.close, size: 18, color: AppColors.muted),
          ),
        ),
      ]),
    );
  }

  Widget _quickAction(IconData icon, String label, VoidCallback? onTap) {
    return HudCard(
      cornerSize: 5,
      borderColor: AppColors.line,
      padding: const EdgeInsets.symmetric(vertical: 13, horizontal: 4),
      onTap: onTap,
      child: Column(
        children: [
          Icon(icon, color: AppColors.cyan, size: 24),
          const SizedBox(height: 8),
          Text(label, style: HudType.hudLabel(size: 11.5).copyWith(letterSpacing: 0.4), textAlign: TextAlign.center),
        ],
      ),
    );
  }

}

class _NotchOutline extends CustomPainter {
  final double corner;
  final Color color;
  _NotchOutline({required this.corner, required this.color});
  @override
  void paint(Canvas canvas, Size size) {
    final c = corner;
    final w = size.width;
    final h = size.height;
    final p = Path()
      ..moveTo(c, 0)
      ..lineTo(w, 0)
      ..lineTo(w, h - c)
      ..lineTo(w - c, h)
      ..lineTo(0, h)
      ..lineTo(0, c)
      ..close();
    canvas.drawPath(p, Paint()..color = color..strokeWidth = 1.5..style = PaintingStyle.stroke);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
