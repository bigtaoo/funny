// Curated pool of real player nicknames, randomly sampled from the Hypixel (Minecraft) public
// nickname dataset (FlorianCassayre/nicknames-datasets, CeCILL-B) and machine+human filtered to
// drop digits-heavy junk, non-word garbage, and profanity/slurs/political references. Used by
// randomPlayerName() so guest and bot accounts read like handles real players actually pick.
// This is a one-off curated snapshot, not build-generated; extend by hand as needed.
export const PLAYER_NAME_POOL: readonly string[] = [
  'AbsydeAuberon', 'AC_Jeankastre', 'Accutherm', 'AceroGamer', 'AcidicPikachu', 'AdamLikesCars', 'AdamvinnFTW', 'ADRIANSMITH', 'Aexony', 'Aeziak',
  'ai_te', 'AJVenom', 'AkhilD', 'Akydearest', 'Alyssatp', 'Ambrose_Asylum', 'AMCmikol', 'AngeberSnipsx', 'AngelaVanityy', 'antsimis',
  'Appeltjesap', 'ApsterCoold', 'Archangelfox', 'Armandojnz', 'ArmanGaming', 'AurshChi', 'avonturenboy', 'Ayuma_chan', 'azariahlowry', 'barburrito',
  'BarleyBlue', 'Bartely', 'Batfam', 'beastoftheland', 'Beezz', 'BeGlory', 'Bennetprime', 'BerryHD', 'bijstergame', 'Binneur',
  'BlackArrowCrow', 'BlackBugBro', 'Bllanker', 'BMonsta', 'boazmulder', 'BrawnyPirate', 'brentbobbie', 'broodjebaard', 'BrookeMariee',
  'BStere', 'BubbleCast', 'by_Soartix', 'Byswegger', 'cajkaCZ', 'campeadorzx', 'chaleta', 'Ciindy', 'ClunkyApollo',
  'CoffeeIsHere', 'Coirck', 'CosmicMapMaker', 'craftedgun', 'Crafty_Chaps', 'creepercaoimhe', 'Cryonide', 'CubiX_Angel', 'DamanikS', 'Danielou',
  'DanXU', 'Darexim', 'Dark_Stalker', 'denvache', 'Deuso', 'DiddoOl', 'Didiomedeiro', 'DismiC', 'DoraBaby', 'DragonbornBR',
  'dragonclawM', 'DragonSpirits', 'Drake_Uno', 'DruidOfDiscord', 'drunkpigeons', 'eGOArtimus', 'Eizaki', 'emilbrusevold', 'EnioHD', 'EpicMidType',
  'Erikhq', 'ertopia', 'Etellex', 'EternalAnkh', 'EuSouOPedrin', 'EZ_Builder', 'FadiX_Gaming', 'FarmyButSlaper', 'Feng_Zhi',
  'fernandodealba', 'FireSender', 'fishva', 'fishysquishy', 'Fiszmanator', 'FraKa_ToP', 'GalaxyAngelMC', 'GasTiLeNy', 'Generational', 'GeNeRiix_Fury',
  'girliecreeper', 'GodlikeDog', 'Goggle_Cat', 'Goldbunni', 'Gradune', 'Grapples', 'Greelow', 'Gudjon_Teitur', 'GuiCella', 'Helumiberg',
  'henryirwin', 'iDevilInu', 'IDNL_Burger', 'iforan', 'iGripex', 'iiDrareg', 'iiSaphire', 'IMasterPlus', 'Itz_Kaspian',
  'ItzzSoap', 'iXephosGamer', 'JackyTheGame', 'Jahleel', 'jamesday', 'jasonpere', 'Jaz_Icecream', 'JeremyCraftFTW', 'Joelishere', 'Johan_HB',
  'JohnnyMdoesMC', 'JomiGames', 'Jophax', 'JuaooFtw', 'Julesgger', 'JustinvanM', 'Kaansims', 'Kasmose', 'Khaoatic_Owner', 'KiaraBob',
  'king_of_riot', 'KittyGlor', 'KoalaTubbie', 'KOJO_ARG', 'koperplay', 'Krash_Chaos', 'Krunchy_Kandy', 'lazeral', 'LeFlex', 'Lefting',
  'LemonZeus', 'LeNougatFondu', 'LiGLeader', 'LimeMutt', 'Linduff', 'Lipegstriker', 'Litte_Alex', 'Lizard_Toucher', 'LizcanoXD', 'LostGumball',
  'luisCc', 'Lumicorn', 'LungKuang', 'Magic_Archer', 'magical_rinrin', 'Mai_le', 'markitosdraco', 'masterdarkvoid', 'MatGamiing', 'MatthewTrey',
  'Meeafterfx', 'Meldamos', 'metal_shark', 'MichelRandom', 'micksarah', 'Minty_Bean', 'mlgDragazo', 'Mlle_Axelle', 'MoJoe_Sparks',
  'MrHamdi', 'MrSplaashMan', 'Myrith', 'MysticJtex', 'Mystigian', 'Myxario', 'Natanjim', 'nathacier', 'nathan_ender', 'nekski',
  'Ninjachris', 'NinjaOJ', 'NITEBEASTER', 'NonVtec', 'normanzerga', 'NurPhilipp', 'NyatsuSenpai', 'ObitoPvP', 'OldLadyMc', 'oriont',
  'Oscares', 'OSLSmoke', 'OverTop_Games', 'PanchoLeBerger', 'PetbelGrand', 'PixelFab', 'PokemonBldr', 'Ponii', 'popie_games', 'popwser',
  'Pranula', 'PrimeStrafes', 'ProtectGamer', 'Qootam', 'QuantumLand', 'QuantumXgaming', 'Queltzy', 'RafaelCraftFTW', 'rangsta', 'Rankenz',
  'Raskyy', 'RaspberryCloud', 'Reyfa', 'Rhinkee', 'RiftWraith', 'Risthil', 'RivenTheOG', 'rojosa', 'sadgroceries', 'SaiFang',
  'Savollix', 'ScudellerG', 'Seamoo', 'sennetje', 'Shaebaumers', 'Shuuzo', 'Sitania', 'SkyTheBeast', 'SkythekidMax', 'Snjofljo',
  'SodaPopGamer', 'sokmnjiu', 'Soolix', 'SosisaGN', 'SpelletjesCrew', 'SQAHStheKING', 'SteelArcher', 'Stowlen', 'StreetyTheKid', 'StrikerMiker',
  'SugoiSugio', 'SummerRubyGirl', 'TehDreamzz', 'TerbonLP', 'TheKingCatFish', 'theotouss', 'TheUnityEla', 'Thoquent', 'TiegaPlaysYT', 'TirramisouPRML',
  'Tpanter', 'TrickyLP', 'TristanFrazer', 'TrollJonI', 'TSP_LeaaPvP', 'TuckTheTurtle', 'unsciswithme', 'verdiient', 'Vestigify', 'Vituga',
  'VladValdemar', 'Voltjunkie', 'Vroominator', 'westerson', 'wispio', 'WolfenCody', 'wolkenman', 'xBudderz', 'Xivanos',
  'xX_Abdulali_xX', 'xXSir_MoopXx', 'xY_DereK_Yx', 'youngshadownl', 'yPaaulO', 'ypanda', 'Zach_Go', 'ZapFlyerz', 'Zeleonn', 'Ziikros',
];
